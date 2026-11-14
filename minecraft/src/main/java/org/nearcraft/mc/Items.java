package org.nearcraft.mc;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;

/**
 * The join between a NEP-245 token id and a block a player can hold.
 *
 * <p>The catalog in {@code config/catalog.json} names its materials
 * {@code iron_ingot}, {@code oak_log}, {@code stone} and so on — which are
 * already Minecraft material names, so no translation table is needed and none
 * is written here. A hand-maintained map would be one more thing to rot.
 *
 * <p><b>Why these take an {@link Inventory} and not a {@link Player}.</b> A
 * player cannot be constructed without a client connecting, so code written
 * against {@code Player} can only ever be exercised by someone joining the
 * server. Written against {@code Inventory} the same code can be driven by a
 * real {@code PlayerInventory} <i>and</i> by {@code Bukkit.createInventory},
 * which is how {@code /nearcraft inventory-selftest} checks it from the console
 * on a machine with no Minecraft account.
 *
 * <p><b>Why the documented mutators.</b> An earlier version of this file removed
 * blocks by mutating the array {@code getContents()} returns. The Bukkit API
 * promises nothing about whether that writes back, and on a player inventory
 * {@code getContents()} spans more slots than {@code removeItem} does — so a
 * pre-check could pass and the removal still fail. Everything here now goes
 * through {@code removeItemAnySlot} and {@code addItem}, whose contracts are
 * defined in terms of what they could <i>not</i> move, and every result is
 * judged by that return value rather than by a check made beforehand.
 *
 * <p><b>The honest part.</b> Moving a stack is a game-side effect applied after
 * the chain has already settled. The chain is the ledger of record; the
 * inventory is a view of it that this plugin keeps by hand. A crash between the
 * relayed call and the inventory change diverges the two, and nothing here
 * repairs that. EthCraft solved it with an escrow and a durable journal, and
 * neither is ported — see the limits section of docs/MINECRAFT.md.
 */
public final class Items {

  private Items() {}

  /**
   * The material a token id names, or null when the chain names something this
   * game has no block for.
   */
  public static Material materialFor(String tokenId) {
    if (tokenId == null || tokenId.isBlank()) return null;
    return Material.matchMaterial(tokenId.trim().toLowerCase());
  }

  /**
   * The blocks a player would gather to obtain a traded material.
   *
   * <p>This is NOT {@link #materialFor}. That answers "what block is this token
   * id", which is what a trade moves. This answers "what would you mine or chop
   * to get one in the first place", which is a different question with a
   * different answer for five of the eight materials: an {@code iron_ingot}
   * comes out of {@code iron_ore} by way of a furnace, {@code glass} out of
   * {@code sand}, {@code oak_planks} out of {@code oak_log}.
   *
   * <p><b>Why this exists.</b> The server generated a default superflat
   * world — bedrock, two dirt, one grass — in survival mode, so NOT ONE of the
   * eight traded materials could be gathered, and the first of the three core
   * actions in GAME_LOOP.md was impossible. Nothing noticed, because nothing
   * ever asked the world what was in it. {@code /nearcraft world-selftest}
   * asks, and this is the table it asks with.
   *
   * <p>Deepslate variants are included because below roughly y=0 that is the
   * only form the ore takes, and a scan that looked only for {@code iron_ore}
   * would report a deep world as empty of iron.
   *
   * <p>Looked up by name through {@link Material#matchMaterial} rather than
   * written as enum constants, so a material this server's version does not
   * have is absent from the list instead of failing the build.
   *
   * @return the blocks that yield it, or an empty list when nothing here knows
   */
  public static List<Material> sourcesFor(String tokenId) {
    if (tokenId == null || tokenId.isBlank()) return List.of();
    String id = tokenId.trim().toLowerCase();
    String[] names;
    switch (id) {
      case "iron_ingot":   names = new String[] {"iron_ore", "deepslate_iron_ore"}; break;
      case "copper_ingot": names = new String[] {"copper_ore", "deepslate_copper_ore"}; break;
      case "coal":         names = new String[] {"coal_ore", "deepslate_coal_ore"}; break;
      case "redstone":     names = new String[] {"redstone_ore", "deepslate_redstone_ore"}; break;
      case "glass":        names = new String[] {"sand"}; break;
      case "oak_planks":   names = new String[] {"oak_log"}; break;
      case "stone":        names = new String[] {"stone", "deepslate"}; break;
      // oak_log, and anything else whose token id is already the block you
      // gather, needs no translation.
      default:             names = new String[] {id}; break;
    }
    List<Material> out = new ArrayList<>();
    for (String name : names) {
      Material material = Material.matchMaterial(name);
      if (material != null && !out.contains(material)) out.add(material);
    }
    return List.copyOf(out);
  }

  /**
   * How many of a material this inventory is carrying.
   *
   * <p>Counted across every slot the inventory exposes, which for a player
   * includes the offhand — the same reach {@link #take} has. This figure is
   * only ever shown to a player in a refusal message; nothing decides anything
   * on it, because a count taken before a removal is exactly the kind of
   * check {@link #take} was rewritten to stop trusting.
   */
  public static int held(Inventory inventory, Material material) {
    int total = 0;
    for (ItemStack stack : inventory.getContents()) {
      if (stack != null && stack.getType() == material) total += stack.getAmount();
    }
    return total;
  }

  /**
   * Take exactly {@code count} of a material, or take nothing.
   *
   * <p>All-or-nothing on purpose: a partial take would charge a player blocks
   * for a sale the chain then refused. The guarantee does not come from asking
   * first — it comes from {@code removeItemAnySlot} reporting what it could not
   * remove, and from putting back whatever did come out when that report is not
   * empty.
   *
   * <p>{@code removeItemAnySlot} rather than {@code removeItem} so that a
   * player holding their last ingot in the offhand can still sell it.
   *
   * @return false when the inventory did not hold enough, having changed nothing
   */
  public static boolean take(Inventory inventory, Material material, int count) {
    if (count <= 0) return false;
    Map<Integer, ItemStack> notRemoved = inventory.removeItemAnySlot(new ItemStack(material, count));
    if (notRemoved.isEmpty()) return true;

    int short_ = 0;
    for (ItemStack stack : notRemoved.values()) short_ += stack.getAmount();
    int removed = count - short_;
    // Undo a partial removal. Bukkit removes "as much as possible", so a short
    // inventory leaves the player minus some blocks and minus the sale.
    if (removed > 0) inventory.addItem(new ItemStack(material, removed));
    return false;
  }

  /**
   * Put a stack in, and hand back whatever would not fit.
   *
   * <p>The caller decides what to do with the remainder, because an
   * {@code Inventory} alone has nowhere to put it.
   */
  public static List<ItemStack> give(Inventory inventory, Material material, int count) {
    if (count <= 0) return List.of();
    return new ArrayList<>(inventory.addItem(new ItemStack(material, count)).values());
  }

  /**
   * Give a player a stack, dropping at their feet whatever will not fit.
   *
   * <p>Dropping rather than voiding the remainder: the chain has already moved
   * the material, so silently discarding it would make the game and the ledger
   * disagree in the one direction a player would never notice.
   */
  public static void giveOrDrop(Player player, Material material, int count) {
    for (ItemStack leftover : give(player.getInventory(), material, count)) {
      player.getWorld().dropItemNaturally(player.getLocation(), leftover);
    }
  }
}
