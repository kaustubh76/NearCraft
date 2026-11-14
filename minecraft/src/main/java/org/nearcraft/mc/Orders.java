package org.nearcraft.mc;

import java.util.List;
import java.util.Map;

/**
 * Turning what a player typed into what the chain needs.
 *
 * <p>These three were private helpers inside {@code NearCraftPlugin}, which
 * made them unreachable from any test: the class extends {@code JavaPlugin}, so
 * touching it pulls in a server. They hold <b>no Bukkit types</b> and are pure
 * functions of their arguments, which is the same reason {@link PlayClient} is
 * shaped the way it is — the parts that can be checked without Minecraft should
 * be checkable without Minecraft.
 *
 * <p>What they decide is not cosmetic. {@link #match} is what a player's typo
 * hits, and {@link #count} is the only bound on how much a single command can
 * spend.
 */
public final class Orders {

  /** A stack is 64. An order is at least one. */
  public static final int MAX_COUNT = 64;

  private Orders() {}

  /**
   * Find the merchant a player meant.
   *
   * <p>The chain knows merchants as {@code ironmonger.nearcraftmc.testnet}.
   * Nobody is typing that into a chat box mid-game, so the short handle, the
   * display name and the full id all resolve. Matching is case-insensitive
   * because chat is.
   *
   * <p>The prefix rule requires the dot — {@code iron} must not match
   * {@code ironmonger.…}, or a typo would silently spend against a merchant the
   * player did not name.
   *
   * @return the merchant's row from a {@code /api/market} reply, or null
   */
  public static Map<String, Object> match(PlayClient.Response quotes, String wanted) {
    if (quotes == null || wanted == null) return null;
    if (!(quotes.body.get("merchants") instanceof List)) return null;
    String target = wanted.trim().toLowerCase();
    if (target.isEmpty()) return null;
    for (Object row : Json.asList(quotes.body.get("merchants"))) {
      if (!(row instanceof Map)) continue;
      Map<String, Object> m = Json.asObject(row);
      String id = Json.text(m, "merchantId", "").toLowerCase();
      String name = Json.text(m, "merchantName", "").toLowerCase();
      if (id.equals(target) || (!name.isEmpty() && name.equals(target)) || id.startsWith(target + ".")) {
        return m;
      }
    }
    return null;
  }

  /**
   * The cheapest merchant that is actually open, for a caller that names none.
   *
   * <p>{@code /agent <worker> buy <item>} does not ask a player to pick a
   * merchant — the point of sending an agent is not to do the shopping
   * yourself. The service already returns the rows cheapest first (the market
   * contract orders them, and a test in tests/near/web.mjs asserts it), so this
   * walks them in order and takes the first that will trade.
   *
   * <p>A closed merchant is skipped rather than refused: a world where the
   * cheapest merchant went broke is the normal state of this economy, and the
   * next one along is the answer. Only when none will trade is there nothing to
   * say.
   *
   * @return the cheapest open merchant's row, or null when none will trade
   */
  public static Map<String, Object> cheapest(PlayClient.Response quotes) {
    if (quotes == null) return null;
    if (!(quotes.body.get("merchants") instanceof List)) return null;
    for (Object row : Json.asList(quotes.body.get("merchants"))) {
      if (!(row instanceof Map)) continue;
      Map<String, Object> m = Json.asObject(row);
      if (Boolean.TRUE.equals(m.get("closed"))) continue;
      // An ask of nothing is not a price; a row without one cannot be bought
      // from whatever else it says.
      if (Json.text(m, "unitPrice", "").isBlank()) continue;
      return m;
    }
    return null;
  }

  /** The short name a player types, taken from the account id the chain uses. */
  public static String handle(Map<String, Object> row) {
    String id = Json.text(row, "merchantId", "");
    int dot = id.indexOf('.');
    String shortName = dot > 0 ? id.substring(0, dot) : id;
    String name = Json.text(row, "merchantName", shortName);
    return shortName.isEmpty() ? name : name + " (" + shortName + ")";
  }

  /**
   * The count argument, clamped.
   *
   * <p>Bounded at both ends: zero is not an order, and a stack is 64. Anything
   * unparseable becomes one rather than an error, because the alternative is a
   * player mistyping a digit and being told off instead of buying one ingot.
   *
   * <p>The upper bound is the only limit on what a single command spends, so it
   * is a clamp rather than a suggestion.
   */
  public static int count(String[] args, int index) {
    if (args == null || args.length <= index || args[index] == null) return 1;
    try {
      return Math.max(1, Math.min(MAX_COUNT, Integer.parseInt(args[index].trim())));
    } catch (NumberFormatException e) {
      return 1;
    }
  }

  /** What Minecraft will carry in one chat message or command. */
  public static final int CHAT_LIMIT = 256;

  /**
   * Does this look like someone trying to paste an identity token?
   *
   * <p>Measured, not guessed: a Google id token is about 977 characters and
   * Minecraft caps chat and command input at {@link #CHAT_LIMIT}. A real login
   * is roughly four times too long to arrive intact, so the useful thing to
   * detect is the <i>attempt</i> — including a truncated one, which is what the
   * player would actually manage to send.
   *
   * <p>Every JWT begins {@code eyJ}, because that is base64url for the
   * {@code {"} that opens its header. A fragment of one still begins that way,
   * which is why this test is the prefix rather than the structure: by the time
   * the plugin sees it, the structure is already gone.
   */
  public static boolean looksLikeJwt(String value) {
    if (value == null) return false;
    String text = value.trim();
    if (text.startsWith("eyJ")) return true;
    // Or a complete one that somehow arrived: three dot-separated segments.
    return text.length() > 40 && text.chars().filter((c) -> c == '.').count() >= 2;
  }

  /**
   * The full account id for a merchant a player named by its short handle.
   *
   * <p>Derived from the market contract rather than configured, because they
   * share a parent: {@code market.nearcraftmc.testnet} and
   * {@code ironmonger.nearcraftmc.testnet}. An argument that already carries a
   * dot is taken as a full id and left alone.
   *
   * <p>This exists for investing, which — unlike buying and selling — names no
   * item, so there is no quote list to resolve the handle against.
   *
   * @return the account id, or null when there is nothing to derive from
   */
  public static String merchantId(String wanted, String marketContract) {
    if (wanted == null || wanted.isBlank()) return null;
    String name = wanted.trim().toLowerCase();
    if (name.contains(".")) return name;
    if (marketContract == null || !marketContract.contains(".")) return null;
    return name + marketContract.substring(marketContract.indexOf('.'));
  }
}
