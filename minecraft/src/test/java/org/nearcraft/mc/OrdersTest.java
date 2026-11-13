package org.nearcraft.mc;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What a player typed, and what the chain is asked for.
 *
 * <p>None of this was reachable from a test until {@link Orders} was extracted
 * from the plugin class: a helper private to something that extends
 * {@code JavaPlugin} can only be exercised by starting a server. These are the
 * decisions a typo lands on, so they are worth more than that.
 */
public final class OrdersTest {

  public static int run() {
    Harness h = new Harness("Orders");
    System.out.println("\n--- Orders ---");

    PlayClient.Response quotes = quotes();

    // ------------------------------------------------------------ matching
    h.equals("the short handle resolves", "ironmonger.nearcraftmc.testnet",
        Json.text(Orders.match(quotes, "ironmonger"), "merchantId", ""));
    h.equals("the display name resolves", "stonecutter.nearcraftmc.testnet",
        Json.text(Orders.match(quotes, "Stonecutter"), "merchantId", ""));
    h.equals("the full account id resolves", "ironmonger.nearcraftmc.testnet",
        Json.text(Orders.match(quotes, "ironmonger.nearcraftmc.testnet"), "merchantId", ""));
    h.equals("matching ignores case", "ironmonger.nearcraftmc.testnet",
        Json.text(Orders.match(quotes, "IRONMONGER"), "merchantId", ""));
    h.equals("surrounding space is trimmed", "ironmonger.nearcraftmc.testnet",
        Json.text(Orders.match(quotes, "  ironmonger  "), "merchantId", ""));

    // A partial handle must NOT match. Spending against a merchant the player
    // did not name is worse than making them type the rest of it.
    h.check("a partial handle does not match", Orders.match(quotes, "iron") == null);
    h.check("a longer handle does not match", Orders.match(quotes, "ironmongery") == null);
    h.check("an unknown merchant does not match", Orders.match(quotes, "chandler") == null);
    h.check("an empty name does not match", Orders.match(quotes, "   ") == null);
    h.check("a null name does not match", Orders.match(quotes, null) == null);
    h.check("a null response does not match", Orders.match(null, "ironmonger") == null);
    h.check("a reply with no merchants list does not match",
        Orders.match(new PlayClient.Response(200, Map.of()), "ironmonger") == null);
    h.check("a reply whose rows are not objects does not match",
        Orders.match(new PlayClient.Response(200, Map.of("merchants", List.of("ironmonger"))), "ironmonger") == null);

    // ------------------------------------------------------------- handles
    h.equals("a handle reads as name and short id", "Ironmonger (ironmonger)",
        Orders.handle(Json.asObject(Json.asList(quotes.body.get("merchants")).get(0))));
    Map<String, Object> nameless = new LinkedHashMap<>();
    nameless.put("merchantId", "chandler.nearcraftmc.testnet");
    h.equals("a row with no display name falls back to the short id", "chandler (chandler)",
        Orders.handle(nameless));
    h.equals("a row with nothing at all does not crash", "", Orders.handle(Map.of()));

    // --------------------------------------------------------------- count
    h.equals("a count is read", 7, Orders.count(new String[] {"m", "i", "7"}, 2));
    h.equals("a missing count is one", 1, Orders.count(new String[] {"m", "i"}, 2));
    h.equals("space around the count is trimmed", 3, Orders.count(new String[] {" 3 "}, 0));
    // Clamped at both ends. The upper bound is the only limit on what a single
    // command can spend, so it must hold against anything typed.
    h.equals("zero is clamped up to one", 1, Orders.count(new String[] {"0"}, 0));
    h.equals("a negative count is clamped up to one", 1, Orders.count(new String[] {"-9"}, 0));
    h.equals("a count above a stack is clamped to 64", 64, Orders.count(new String[] {"9999"}, 0));
    h.equals("a count far above int range does not wrap", 1, Orders.count(new String[] {"99999999999999999999"}, 0));
    h.equals("a word is treated as one, not an error", 1, Orders.count(new String[] {"lots"}, 0));
    h.equals("an empty argument is one", 1, Orders.count(new String[] {""}, 0));
    h.equals("a null array is one", 1, Orders.count(null, 0));

    // --------------------------------------------------------- merchant ids
    //
    // Investing names no item, so there is no quote list to resolve against.
    h.equals("a short handle gains the market's parent", "ironmonger.nearcraftmc.testnet",
        Orders.merchantId("ironmonger", "market.nearcraftmc.testnet"));
    h.equals("a full id is left alone", "ironmonger.nearcraftmc.testnet",
        Orders.merchantId("ironmonger.nearcraftmc.testnet", "market.nearcraftmc.testnet"));
    h.equals("case is normalised", "ironmonger.nearcraftmc.testnet",
        Orders.merchantId("IronMonger", "market.nearcraftmc.testnet"));
    h.equals("a sandbox parent works the same way", "ironmonger.sandbox",
        Orders.merchantId("ironmonger", "market.sandbox"));
    h.equals("nothing to derive from gives null", null, Orders.merchantId("ironmonger", "market"));
    h.equals("a null market contract gives null", null, Orders.merchantId("ironmonger", null));
    h.equals("a blank name gives null", null, Orders.merchantId("  ", "market.nearcraftmc.testnet"));

    // ------------------------------------------------- tokens that cannot fit
    //
    // A Google id token is about 977 characters and Minecraft carries 256, so
    // the plugin has to recognise the attempt — including the truncated one a
    // player would actually manage to send.
    String header = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYyJ9";
    h.check("a whole JWT is recognised", Orders.looksLikeJwt(header + ".eyJzdWIiOiIxIn0.c2ln"));
    h.check("a TRUNCATED JWT is still recognised", Orders.looksLikeJwt(header.substring(0, 30)));
    h.check("just the eyJ prefix is enough", Orders.looksLikeJwt("eyJ"));
    h.check("leading space does not hide it", Orders.looksLikeJwt("   eyJhbGciOi"));

    // And the things that must NOT be mistaken for one, or a player cannot sign in.
    h.check("a seed subject is not a token", !Orders.looksLikeJwt("player-1"));
    h.check("a link code is not a token", !Orders.looksLikeJwt("K9FH2MQ7"));
    h.check("an email is not a token", !Orders.looksLikeJwt("someone@example.com"));
    h.check("an account id is not a token", !Orders.looksLikeJwt("p-1d6a3c5d.nearcraftmc.testnet"));
    h.check("null is not a token", !Orders.looksLikeJwt(null));
    h.check("empty is not a token", !Orders.looksLikeJwt(""));
    h.equals("the chat limit is stated once, where the refusal reads it", 256, Orders.CHAT_LIMIT);

    return h.report();
  }

  /** A reply shaped exactly as /api/market answers — see docs/MINECRAFT.md. */
  private static PlayClient.Response quotes() {
    return new PlayClient.Response(200, Json.asObject(Json.parse(
        "{\"item\":\"iron_ingot\",\"count\":1,\"merchants\":["
        + "{\"merchantId\":\"ironmonger.nearcraftmc.testnet\",\"merchantName\":\"Ironmonger\","
        + "\"unitPrice\":\"4000000000000000000000\",\"bid\":\"3200000000000000000000\","
        + "\"buying\":true,\"stock\":253,\"closed\":false,\"reason\":\"stock is deep\"},"
        + "{\"merchantId\":\"stonecutter.nearcraftmc.testnet\",\"merchantName\":\"Stonecutter\","
        + "\"unitPrice\":\"6000000000000000000000\",\"bid\":\"4800000000000000000000\","
        + "\"buying\":true,\"stock\":64,\"closed\":false,\"reason\":\"thin\"}]}")));
  }
}
