package org.nearcraft.mc;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A strict JSON reader and writer, written for this plugin.
 *
 * <p>Why not a library. The plugin has no external dependencies at all: the
 * JDK supplies the HTTP client, and this supplies the one other thing a REST
 * client needs. Shading Gson into the jar would mean a second copy of classes
 * the server may already load, and declaring it would mean trusting that a
 * given Paper build exposes it to plugins. Neither is worth it for eight
 * routes whose shapes are known.
 *
 * <p>Why STRICT. This parses bytes that arrived over a socket. A lenient
 * parser is how a client ends up acting on something the server never said, so
 * every relaxation a parser could offer is refused here: no trailing commas,
 * no unquoted keys, no single quotes, no comments, no NaN, no trailing bytes
 * after the value, no raw control characters inside a string. Input that is
 * not exactly JSON is an error, never a guess.
 *
 * <p>Two bounds exist because this is a parser for untrusted input, not just
 * malformed input: {@link #MAX_DEPTH} stops a deeply nested document from
 * exhausting the Java stack (a recursive-descent parser's one denial-of-
 * service), and {@link #MAX_LENGTH} caps what will be examined at all.
 */
public final class Json {

  /** Deep enough for any response this plugin reads; far short of a stack overflow. */
  public static final int MAX_DEPTH = 64;

  /** A response larger than this is refused unread. The largest real one is a few KiB. */
  public static final int MAX_LENGTH = 1 << 20;

  private Json() {}

  /** Thrown for every malformed input. Carries the offset so a failure can be located. */
  public static final class JsonException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public JsonException(String message, int at) {
      super(message + " (at offset " + at + ")");
    }
  }

  // --------------------------------------------------------------- reading

  /**
   * Parse one complete JSON value.
   *
   * @return a {@code Map<String,Object>}, {@code List<Object>}, {@code String},
   *     {@code Double}, {@code Boolean}, or {@code null}
   */
  public static Object parse(String text) {
    if (text == null) throw new JsonException("no input", 0);
    if (text.length() > MAX_LENGTH) throw new JsonException("input too large", text.length());
    Reader reader = new Reader(text);
    reader.skipWhitespace();
    Object value = reader.value(0);
    reader.skipWhitespace();
    // Trailing bytes mean the sender and this reader disagree about where the
    // message ended, which is never safe to shrug off.
    if (!reader.done()) throw new JsonException("trailing text after the value", reader.at);
    return value;
  }

  private static final class Reader {
    private final String s;
    private int at = 0;

    Reader(String s) { this.s = s; }

    boolean done() { return at >= s.length(); }

    void skipWhitespace() {
      while (at < s.length()) {
        char c = s.charAt(at);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
        else break;
      }
    }

    char need() {
      if (at >= s.length()) throw new JsonException("input ended early", at);
      return s.charAt(at);
    }

    void expect(char c) {
      if (need() != c) throw new JsonException("expected " + c + " but found " + need(), at);
      at++;
    }

    Object value(int depth) {
      if (depth > MAX_DEPTH) throw new JsonException("nested deeper than " + MAX_DEPTH, at);
      char c = need();
      switch (c) {
        case '{': return object(depth);
        case '[': return array(depth);
        case '"': return string();
        case 't': literal("true"); return Boolean.TRUE;
        case 'f': literal("false"); return Boolean.FALSE;
        case 'n': literal("null"); return null;
        default: return number();
      }
    }

    void literal(String word) {
      if (!s.startsWith(word, at)) throw new JsonException("expected " + word, at);
      at += word.length();
    }

    Map<String, Object> object(int depth) {
      expect('{');
      Map<String, Object> out = new LinkedHashMap<>();
      skipWhitespace();
      if (need() == '}') { at++; return out; }
      while (true) {
        skipWhitespace();
        // A key must be a quoted string. Unquoted keys are JavaScript, not JSON.
        if (need() != '"') throw new JsonException("expected a quoted key", at);
        String key = string();
        skipWhitespace();
        expect(':');
        skipWhitespace();
        out.put(key, value(depth + 1));
        skipWhitespace();
        char c = need();
        if (c == ',') { at++; skipWhitespace();
          // A comma must be followed by another member, never by the brace.
          if (need() == '}') throw new JsonException("trailing comma", at);
          continue; }
        if (c == '}') { at++; return out; }
        throw new JsonException("expected , or } but found " + c, at);
      }
    }

    List<Object> array(int depth) {
      expect('[');
      List<Object> out = new ArrayList<>();
      skipWhitespace();
      if (need() == ']') { at++; return out; }
      while (true) {
        skipWhitespace();
        out.add(value(depth + 1));
        skipWhitespace();
        char c = need();
        if (c == ',') { at++; skipWhitespace();
          if (need() == ']') throw new JsonException("trailing comma", at);
          continue; }
        if (c == ']') { at++; return out; }
        throw new JsonException("expected , or ] but found " + c, at);
      }
    }

    String string() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        if (at >= s.length()) throw new JsonException("unterminated string", at);
        char c = s.charAt(at++);
        if (c == '"') return out.toString();
        if (c == '\\') {
          if (at >= s.length()) throw new JsonException("unterminated escape", at);
          char e = s.charAt(at++);
          switch (e) {
            case '"': out.append('"'); break;
            case '\\': out.append('\\'); break;
            case '/': out.append('/'); break;
            case 'b': out.append('\b'); break;
            case 'f': out.append('\f'); break;
            case 'n': out.append('\n'); break;
            case 'r': out.append('\r'); break;
            case 't': out.append('\t'); break;
            case 'u':
              if (at + 4 > s.length()) throw new JsonException("short \\u escape", at);
              String hex = s.substring(at, at + 4);
              for (int i = 0; i < 4; i++) {
                char h = hex.charAt(i);
                boolean ok = (h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F');
                if (!ok) throw new JsonException("bad \\u escape", at + i);
              }
              out.append((char) Integer.parseInt(hex, 16));
              at += 4;
              break;
            default: throw new JsonException("unknown escape \\" + e, at - 1);
          }
          continue;
        }
        // A raw control character inside a string is forbidden by the grammar.
        // Accepting one would let a server smuggle a newline into a line this
        // plugin prints into the game chat.
        if (c < 0x20) throw new JsonException("raw control character in string", at - 1);
        out.append(c);
      }
    }

    Double number() {
      int start = at;
      if (at < s.length() && s.charAt(at) == '-') at++;
      int digits = 0;
      while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') { at++; digits++; }
      if (digits == 0) throw new JsonException("expected a value", start);
      if (at < s.length() && s.charAt(at) == '.') {
        at++;
        int frac = 0;
        while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') { at++; frac++; }
        if (frac == 0) throw new JsonException("digits must follow the decimal point", at);
      }
      if (at < s.length() && (s.charAt(at) == 'e' || s.charAt(at) == 'E')) {
        at++;
        if (at < s.length() && (s.charAt(at) == '+' || s.charAt(at) == '-')) at++;
        int exp = 0;
        while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') { at++; exp++; }
        if (exp == 0) throw new JsonException("digits must follow the exponent", at);
      }
      return Double.valueOf(s.substring(start, at));
    }
  }

  // --------------------------------------------------------------- writing

  /** Render a value as JSON. Accepts the same types {@link #parse} produces. */
  public static String encode(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out, 0);
    return out.toString();
  }

  private static void write(Object value, StringBuilder out, int depth) {
    if (depth > MAX_DEPTH) throw new JsonException("nested deeper than " + MAX_DEPTH, 0);
    if (value == null) { out.append("null"); return; }
    if (value instanceof String) { quote((String) value, out); return; }
    if (value instanceof Boolean) { out.append(value.toString()); return; }
    if (value instanceof Integer || value instanceof Long) { out.append(value.toString()); return; }
    if (value instanceof Double || value instanceof Float) {
      double d = ((Number) value).doubleValue();
      // JSON has no way to spell these, so a writer that emitted them would be
      // producing something no parser should accept.
      if (Double.isNaN(d) || Double.isInfinite(d)) throw new JsonException("not a finite number", 0);
      if (d == Math.rint(d) && Math.abs(d) < 1e15) out.append(Long.toString((long) d));
      else out.append(Double.toString(d));
      return;
    }
    if (value instanceof Map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
        if (!first) out.append(',');
        first = false;
        quote(String.valueOf(e.getKey()), out);
        out.append(':');
        write(e.getValue(), out, depth + 1);
      }
      out.append('}');
      return;
    }
    if (value instanceof List) {
      out.append('[');
      boolean first = true;
      for (Object item : (List<?>) value) {
        if (!first) out.append(',');
        first = false;
        write(item, out, depth + 1);
      }
      out.append(']');
      return;
    }
    throw new JsonException("cannot encode " + value.getClass().getName(), 0);
  }

  private static void quote(String text, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        case '\b': out.append("\\b"); break;
        case '\f': out.append("\\f"); break;
        default:
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
      }
    }
    out.append('"');
  }

  // ------------------------------------------------------------- accessors
  //
  // Every read goes through one of these rather than a cast at the call site,
  // so a response shaped differently from what was expected fails as a missing
  // field instead of a ClassCastException halfway through a command handler.

  @SuppressWarnings("unchecked")
  public static Map<String, Object> asObject(Object value) {
    if (value instanceof Map) return (Map<String, Object>) value;
    throw new JsonException("expected an object", 0);
  }

  @SuppressWarnings("unchecked")
  public static List<Object> asList(Object value) {
    if (value instanceof List) return (List<Object>) value;
    throw new JsonException("expected an array", 0);
  }

  /** A field as text, or {@code fallback} when absent or null. Numbers render without a trailing .0. */
  public static String text(Map<String, Object> object, String key, String fallback) {
    Object value = object == null ? null : object.get(key);
    if (value == null) return fallback;
    if (value instanceof String) return (String) value;
    if (value instanceof Double) {
      double d = (Double) value;
      if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
      return Double.toString(d);
    }
    return String.valueOf(value);
  }

  public static long number(Map<String, Object> object, String key, long fallback) {
    Object value = object == null ? null : object.get(key);
    if (value instanceof Double) return (long) (double) (Double) value;
    if (value instanceof String) {
      try { return Long.parseLong(((String) value).trim()); } catch (NumberFormatException e) { return fallback; }
    }
    return fallback;
  }

  public static boolean flag(Map<String, Object> object, String key, boolean fallback) {
    Object value = object == null ? null : object.get(key);
    return value instanceof Boolean ? (Boolean) value : fallback;
  }
}
