package org.nearcraft.mc;

import java.util.List;
import java.util.Map;

/** What the parser must accept, and — mostly — what it must refuse. */
public final class JsonTest {

  public static int run() {
    Harness h = new Harness("Json");
    System.out.println("\n--- Json ---");

    // ------------------------------------------------------------ accepting
    Map<String, Object> body = Json.asObject(Json.parse(
        "{\"sessionId\":\"s-1\",\"accountId\":\"p-1.testnet\",\"created\":false,"
        + "\"permittedMethods\":[\"buy_with_credit\",\"sell\"],\"fullAccessKeys\":0}"));
    h.equals("a string field reads back", "s-1", Json.text(body, "sessionId", ""));
    h.equals("a false boolean is not mistaken for absent", false, Json.flag(body, "created", true));
    h.equals("a number field reads back", 0L, Json.number(body, "fullAccessKeys", -1));
    h.equals("an array field keeps its order", List.of("buy_with_credit", "sell"),
        Json.asList(body.get("permittedMethods")).stream().map(String::valueOf).toList());
    h.equals("a missing field falls back", "none", Json.text(body, "nothing", "none"));

    // A u128 arrives as a decimal STRING, and must not be rounded through a
    // double on its way to being displayed. This is the whole reason `text`
    // exists rather than a cast.
    Map<String, Object> amounts = Json.asObject(Json.parse(
        "{\"credit\":\"4876800000000000000000\",\"playerNearDelta\":\"0\"}"));
    h.equals("a yoctoNEAR amount survives verbatim",
        "4876800000000000000000", Json.text(amounts, "credit", ""));
    h.equals("a zero delta is the string zero, not 0.0", "0", Json.text(amounts, "playerNearDelta", ""));

    // An integer-valued number must not print as 1.0 in game chat.
    h.equals("a whole number renders without a decimal tail", "7",
        Json.text(Json.asObject(Json.parse("{\"n\":7}")), "n", ""));

    h.equals("escapes decode", "a\"b\\c\nd\te",
        Json.text(Json.asObject(Json.parse("{\"s\":\"a\\\"b\\\\c\\nd\\te\"}")), "s", ""));
    h.equals("a unicode escape decodes", "\u00a76",
        Json.text(Json.asObject(Json.parse("{\"s\":\"\\u00a76\"}")), "s", ""));
    h.equals("an empty object parses", 0, Json.asObject(Json.parse("{}")).size());
    h.equals("an empty array parses", 0, Json.asList(Json.parse("[]")).size());
    h.check("a null field is null", Json.asObject(Json.parse("{\"a\":null}")).get("a") == null);

    // ------------------------------------------------------------- refusing
    //
    // Each of these is a relaxation some parser somewhere offers. A client that
    // accepted them would act on something the server did not say.
    h.refuses("a trailing comma in an object", "trailing comma", () -> Json.parse("{\"a\":1,}"));
    h.refuses("a trailing comma in an array", "trailing comma", () -> Json.parse("[1,2,]"));
    h.refuses("an unquoted key", "expected a quoted key", () -> Json.parse("{a:1}"));
    h.refuses("single quotes", null, () -> Json.parse("{'a':1}"));
    h.refuses("a comment", null, () -> Json.parse("{\"a\":1} // hi"));
    h.refuses("trailing text after the value", "trailing text", () -> Json.parse("{\"a\":1} {}"));
    h.refuses("NaN", null, () -> Json.parse("{\"a\":NaN}"));
    h.refuses("an unterminated string", "unterminated string", () -> Json.parse("{\"a\":\"x}"));
    h.refuses("an unknown escape", "unknown escape", () -> Json.parse("{\"a\":\"\\q\"}"));
    h.refuses("a short unicode escape", null, () -> Json.parse("{\"a\":\"\\u00\"}"));
    h.refuses("a non-hex unicode escape", "bad \\u escape", () -> Json.parse("{\"a\":\"\\u00zz\"}"));
    h.refuses("a bare minus", null, () -> Json.parse("-"));
    h.refuses("a decimal point with no digits", null, () -> Json.parse("1."));
    h.refuses("an exponent with no digits", null, () -> Json.parse("1e"));
    h.refuses("empty input", "input ended early", () -> Json.parse(""));
    h.refuses("null input", "no input", () -> Json.parse(null));

    // A raw newline inside a string would let a service smuggle extra lines
    // into what this plugin prints into chat.
    h.refuses("a raw control character in a string", "raw control character",
        () -> Json.parse("{\"a\":\"x\ny\"}"));

    // Recursive descent has one denial-of-service, and it is the stack.
    StringBuilder deep = new StringBuilder();
    for (int i = 0; i < Json.MAX_DEPTH + 5; i++) deep.append('[');
    h.refuses("nesting past the depth limit", "nested deeper", () -> Json.parse(deep.toString()));

    String tooLong = "\"" + "x".repeat(Json.MAX_LENGTH + 10) + "\"";
    h.refuses("input past the length limit", "too large", () -> Json.parse(tooLong));

    h.refuses("a top-level value where an object was needed", "expected an object",
        () -> Json.asObject(Json.parse("[1]")));

    // ------------------------------------------------- the exception itself
    //
    // Every refusal above is caught as a RuntimeException by the harness, which
    // never checks WHICH exception or whether the offset it carries is any use.
    // A parser that reported "bad input" with no position would be much harder
    // to debug against a live service, and the offset is the only thing that
    // makes these messages actionable.
    try {
      Json.parse("{\"a\":1,}");
      throw new IllegalStateException("a malformed document was accepted");
    } catch (Json.JsonException e) {
      h.check("the failure is a JsonException, not something generic", true);
      h.check("and it names the offset", e.getMessage().contains("at offset"));
      h.check("which points past the comma, not at zero", e.getMessage().contains("offset 7"));
    }
    try {
      Json.parse("[1,2");
      throw new IllegalStateException("an unterminated array was accepted");
    } catch (Json.JsonException e) {
      h.check("an unterminated array reports where the input ran out",
          e.getMessage().contains("input ended early") && e.getMessage().contains("offset 4"));
    }

    // ------------------------------------------------------------- encoding
    h.equals("an order encodes with count as a NUMBER",
        "{\"sessionId\":\"s\",\"merchantId\":\"ironmonger\",\"item\":\"iron_ingot\",\"count\":2}",
        Json.encode(order()));
    h.equals("a quote in a value is escaped", "{\"a\":\"he said \\\"hi\\\"\"}",
        Json.encode(Map.of("a", "he said \"hi\"")));
    h.equals("a newline in a value is escaped", "{\"a\":\"x\\ny\"}", Json.encode(Map.of("a", "x\ny")));
    h.refuses("encoding a non-finite number", "finite", () -> Json.encode(Map.of("a", Double.NaN)));

    h.equals("encode then parse is a round trip", "iron_ingot",
        Json.text(Json.asObject(Json.parse(Json.encode(Map.of("item", "iron_ingot")))), "item", ""));

    // ------------------------------------------------------------- amounts
    //
    // A u128 of yoctoNEAR has up to 39 digits; a double carries about 15. Every
    // one of these would be wrong if this went through Double.parseDouble.
    h.equals("iron at 0.004 NEAR", "0.004", Amounts.near("4000000000000000000000"));
    h.equals("a whole NEAR", "1", Amounts.near("1000000000000000000000000"));
    h.equals("zero stays zero", "0", Amounts.near("0"));
    h.equals("one yoctoNEAR keeps all 24 places", "0.000000000000000000000001", Amounts.near("1"));
    // 30 digits: six whole and twenty-four fractional. Composed, for the same
    // reason as above — this test got the digit count wrong twice by hand, which
    // is the exact failure class that has rotted the counted claims in this
    // repository five times.
    h.equals("a long balance is not rounded", "123456.789012345678901234",
        Amounts.near("123456" + "789012345678901234" + "000000"));
    // Built rather than hand-counted: writing 21 zeros in a literal is how a
    // test asserts the wrong number and blames the code.
    h.equals("leading zeros do not survive", "0.004", Amounts.near("000" + "4" + "0".repeat(21)));
    h.equals("a negative delta keeps its sign", "-0.004", Amounts.near("-4000000000000000000000"));
    h.equals("something that is not a number comes back untouched", "n/a", Amounts.near("n/a"));
    h.equals("null is zero", "0", Amounts.near(null));
    h.equals("the unit is appended", "0.004 NEAR", Amounts.nearWithUnit("4000000000000000000000"));

    // ----------------------------------------------------------- NEAR -> yocto
    //
    // This direction builds an argument the CONTRACT acts on, so a rounding
    // error here stakes an amount nobody agreed to.
    h.equals("a stake of 0.05 NEAR", "5" + "0".repeat(22), Amounts.yocto("0.05"));
    h.equals("one whole NEAR", "1" + "0".repeat(24), Amounts.yocto("1"));
    h.equals("zero", "0", Amounts.yocto("0"));
    h.equals("zero with a decimal tail", "0", Amounts.yocto("0.000"));
    h.equals("a leading dot is accepted", "5" + "0".repeat(23), Amounts.yocto(".5"));
    h.equals("surrounding space is trimmed", "4" + "0".repeat(21), Amounts.yocto("  0.004 "));
    h.equals("exactly 24 decimal places is the smallest unit", "1", Amounts.yocto("0." + "0".repeat(23) + "1"));
    h.equals("a big amount is not rounded", "123456" + "789012345678901234" + "000000",
        Amounts.yocto("123456.789012345678901234"));

    // Refusals. Each of these is something a player could type.
    h.equals("25 decimal places is finer than the chain goes, so refused",
        null, Amounts.yocto("0." + "0".repeat(24) + "1"));
    h.equals("a negative stake is refused", null, Amounts.yocto("-1"));
    h.equals("two decimal points are refused", null, Amounts.yocto("1.2.3"));
    h.equals("letters are refused", null, Amounts.yocto("1e24"));
    h.equals("a bare dot is refused", null, Amounts.yocto("."));
    h.equals("empty is refused", null, Amounts.yocto("   "));
    h.equals("null is refused", null, Amounts.yocto(null));

    // The two directions must agree, or one of them is wrong.
    h.equals("yocto then near is a round trip", "0.05", Amounts.near(Amounts.yocto("0.05")));
    h.equals("near then yocto is a round trip too",
        "4" + "0".repeat(21), Amounts.yocto(Amounts.near("4" + "0".repeat(21))));

    return h.report();
  }

  /** The exact shape PlayClient.order builds, spelled out so the encoder is held to it. */
  private static Map<String, Object> order() {
    Map<String, Object> out = new java.util.LinkedHashMap<>();
    out.put("sessionId", "s");
    out.put("merchantId", "ironmonger");
    out.put("item", "iron_ingot");
    out.put("count", Integer.valueOf(2));
    return out;
  }
}
