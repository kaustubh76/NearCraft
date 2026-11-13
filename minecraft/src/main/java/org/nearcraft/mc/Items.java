package org.nearcraft.mc;

import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;

/**
 * The join between a NEP-245 token id and a block a player can hold.
 *
 * <p>The catalog in {@code config/catalog.json} names its materials
 * {@code iron_ingot}, {@code oak_log}, {@code stone} and so on — which are
 * already Minecraft material names, so no translation table is needed and none
 * is written here. A hand-maintained map would be one more thing to rot.
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

  /** How many of a material a player is carrying, counted across the whole inventory. */
  public static int held(Player player, Material material) {
    int total = 0;
    for (ItemStack stack : player.getInventory().getContents()) {
      if (stack != null && stack.getType() == material) total += stack.getAmount();
    }
    return total;
  }

  /**
   * Take exactly {@code count} of a material, or take nothing.
   *
   * <p>All-or-nothing on purpose: a partial take would charge a player blocks
   * for a sale the chain then refused.
   *
   * @return false when the player does not hold enough, having changed nothing
   */
  public static boolean take(Player player, Material material, int count) {
    if (count <= 0) return false;
    if (held(player, material) < count) return false;
    int remaining = count;
    ItemStack[] contents = player.getInventory().getContents();
    for (int i = 0; i < contents.length && remaining > 0; i++) {
      ItemStack stack = contents[i];
      if (stack == null || stack.getType() != material) continue;
      int take = Math.min(remaining, stack.getAmount());
      stack.setAmount(stack.getAmount() - take);
      remaining -= take;
      if (stack.getAmount() <= 0) player.getInventory().setItem(i, null);
    }
    return true;
  }

  /**
   * Give a player a stack, dropping at their feet whatever will not fit.
   *
   * <p>Dropping rather than voiding the remainder: the chain has already moved
   * the material, so silently discarding it would make the game and the ledger
   * disagree in the one direction a player would never notice.
   */
  public static void give(Player player, Material material, int count) {
    if (count <= 0) return;
    for (ItemStack leftover : player.getInventory().addItem(new ItemStack(material, count)).values()) {
      player.getWorld().dropItemNaturally(player.getLocation(), leftover);
    }
  }
}
