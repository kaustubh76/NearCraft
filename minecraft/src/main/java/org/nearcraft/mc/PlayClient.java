package org.nearcraft.mc;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The plugin's whole connection to NEAR: an HTTP client for the play service
 * in {@code backend/near/play.mjs}.
 *
 * <p><b>There is deliberately no chain code below this.</b> No key, no signer,
 * no RPC, no NEP-366 delegate construction. Those exist once, in JavaScript,
 * behind 21 unit tests and an end-to-end test against a real node. A second
 * implementation in Java would be a second thing to get wrong, and a custodial
 * key in a second place — inside a game server, which is the least trustworthy
 * process in this system because it is the one players connect to.
 *
 * <p>This class holds <b>no Bukkit types</b>, which is what lets the tests
 * drive every route against a stub HTTP server with no Minecraft running.
 *
 * <p>The service it calls is unauthenticated and custodial by design: it is
 * meant to sit on loopback beside the game server. {@link #PlayClient} refuses
 * to send a session id in clear text to anywhere but loopback — see
 * {@link #normaliseBase}.
 */
public final class PlayClient {

  /** A read. Short, because a view call either answers quickly or is wedged. */
  private static final Duration READ_TIMEOUT = Duration.ofSeconds(20);

  /**
   * A write. Long, because this covers a relayed delegate: the service submits
   * it, the node includes it, and the receipt has to be observed before the
   * service can report whether the inner call panicked. Measured at about 8s
   * against a sandbox, and testnet is slower.
   */
  private static final Duration WRITE_TIMEOUT = Duration.ofSeconds(60);

  private final String base;
  private final HttpClient http;

  public PlayClient(String baseUrl) {
    this.base = normaliseBase(baseUrl);
    this.http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        // The service answers on the same host; a redirect would mean something
        // other than the service answered, so do not follow one.
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
  }

  /** The address this client will talk to, after validation. */
  public String base() { return base; }

  /**
   * Validate the configured service address.
   *
   * <p>Two refusals, both about the same risk. Every call after sign-in carries
   * a session id, and a session id is bearer authority over a player's account
   * on this deployment. Sending one in clear text to a machine across a network
   * hands it to anything on the path, so plain {@code http} is accepted only
   * for loopback, where there is no path. Anything else must be {@code https}.
   */
  static String normaliseBase(String raw) {
    if (raw == null || raw.isBlank()) throw new IllegalArgumentException("no service address configured");
    String trimmed = raw.trim();
    while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
    URI uri;
    try {
      uri = URI.create(trimmed);
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException("service address is not a URL: " + raw);
    }
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
    String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
    if (!scheme.equals("http") && !scheme.equals("https")) {
      throw new IllegalArgumentException("service address must be http or https, not " + scheme);
    }
    if (host.isEmpty()) throw new IllegalArgumentException("service address has no host: " + raw);
    boolean loopback = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("[::1]");
    if (scheme.equals("http") && !loopback) {
      throw new IllegalArgumentException(
          "refusing plain http to " + host + ": a session id is bearer authority over a player's "
          + "account and would travel in clear text. Use https, or run the service on loopback.");
    }
    return trimmed;
  }

  /** What a route answered: the HTTP status and the parsed body, whichever it was. */
  public static final class Response {
    /** The HTTP status, or 0 when the service could not be reached at all. */
    public final int status;
    public final Map<String, Object> body;

    Response(int status, Map<String, Object> body) {
      this.status = status;
      this.body = body == null ? Map.of() : body;
    }

    public boolean ok() { return status >= 200 && status < 300; }

    /** The service's error code, or a synthetic one when it never answered. */
    public String error() { return Json.text(body, "error", status == 0 ? "SERVICE_UNREACHABLE" : "HTTP_" + status); }

    public String detail() { return Json.text(body, "detail", ""); }

    /** One line fit to print into game chat: the code, and the reason if there is one. */
    public String refusal() {
      String detail = detail();
      return detail.isEmpty() ? error() : error() + " — " + detail;
    }
  }

  // ----------------------------------------------------------------- reads

  public Response health() { return get("/api/health", Map.of()); }

  public Response materials() { return get("/api/materials", Map.of()); }

  public Response market(String item, int count) {
    // A LinkedHashMap, not Map.of: the JDK randomises Map.of iteration order on
    // purpose, which would make the same call produce a different query string
    // from one run to the next. A request that is not byte-stable is miserable
    // to compare against a server log.
    Map<String, String> query = new LinkedHashMap<>();
    query.put("item", item);
    query.put("count", Integer.toString(count));
    return get("/api/market", query);
  }

  public Response me(String sessionId) {
    Map<String, String> query = new LinkedHashMap<>();
    query.put("sessionId", sessionId);
    return get("/api/me", query);
  }

  // ---------------------------------------------------------------- writes

  public Response signIn(String token) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("token", token);
    return post("/api/session", body);
  }

  /**
   * Exchange a one-time code for a session.
   *
   * <p>The code, not a token: the thing a player can actually type. See
   * {@link Orders#looksLikeJwt} for the measurement that makes this necessary.
   */
  public Response claim(String code) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("code", code);
    return post("/api/link", body);
  }

  public Response buy(String sessionId, String merchantId, String item, int count) {
    return post("/api/buy", order(sessionId, merchantId, item, count));
  }

  public Response sell(String sessionId, String merchantId, String item, int count) {
    return post("/api/sell", order(sessionId, merchantId, item, count));
  }

  public Response invest(String sessionId, String merchantId, String amount) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("sessionId", sessionId);
    body.put("merchantId", merchantId);
    body.put("amount", amount);
    return post("/api/invest", body);
  }

  private static Map<String, Object> order(String sessionId, String merchantId, String item, int count) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("sessionId", sessionId);
    body.put("merchantId", merchantId);
    body.put("item", item);
    // A JSON number, because the service does Number(body.count). The one
    // argument that must NOT become a number is the approval id, and the
    // service reads that off the chain itself rather than taking it from here.
    body.put("count", Integer.valueOf(count));
    return body;
  }

  // ------------------------------------------------------------- transport

  private Response get(String path, Map<String, String> query) {
    StringBuilder url = new StringBuilder(base).append(path);
    boolean first = true;
    for (Map.Entry<String, String> e : query.entrySet()) {
      url.append(first ? '?' : '&');
      first = false;
      url.append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
         .append('=')
         .append(URLEncoder.encode(e.getValue() == null ? "" : e.getValue(), StandardCharsets.UTF_8));
    }
    HttpRequest request = HttpRequest.newBuilder(URI.create(url.toString()))
        .timeout(READ_TIMEOUT)
        .header("Accept", "application/json")
        .GET()
        .build();
    return send(request);
  }

  private Response post(String path, Map<String, Object> body) {
    HttpRequest request = HttpRequest.newBuilder(URI.create(base + path))
        .timeout(WRITE_TIMEOUT)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(Json.encode(body), StandardCharsets.UTF_8))
        .build();
    return send(request);
  }

  private Response send(HttpRequest request) {
    try {
      HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
      String text = readBounded(response.body());
      Map<String, Object> parsed;
      try {
        parsed = text.isBlank() ? Map.of() : Json.asObject(Json.parse(text));
      } catch (RuntimeException e) {
        // The service answered with something that is not a JSON object. Report
        // it as its own failure rather than letting a parse error escape into a
        // command handler as an unhandled exception.
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("error", "BAD_RESPONSE");
        bad.put("detail", e.getMessage());
        return new Response(response.statusCode(), bad);
      }
      return new Response(response.statusCode(), parsed);
    } catch (IOException e) {
      return unreachable(e.getMessage() == null ? e.toString() : e.getMessage());
    } catch (InterruptedException e) {
      // Restore the flag rather than swallowing it: this runs on a scheduler
      // thread the server owns and may be shutting down.
      Thread.currentThread().interrupt();
      return unreachable("interrupted");
    }
  }

  private Response unreachable(String detail) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", "SERVICE_UNREACHABLE");
    body.put("detail", detail + " — is `npm run play` running at " + base + "?");
    return new Response(0, body);
  }

  /**
   * Read a response body, refusing one larger than {@link Json#MAX_LENGTH}.
   *
   * <p>{@code BodyHandlers.ofString} would buffer whatever arrives before this
   * plugin got a say. The service is trusted, but it is reached over a socket
   * and a game server should not be the thing that runs out of heap because
   * something else on the host answered on that port.
   */
  private static String readBounded(InputStream in) throws IOException {
    byte[] buffer = new byte[8192];
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    int total = 0;
    try (InputStream stream = in) {
      int read;
      while ((read = stream.read(buffer)) != -1) {
        total += read;
        if (total > Json.MAX_LENGTH) throw new IOException("response larger than " + Json.MAX_LENGTH + " bytes");
        out.write(buffer, 0, read);
      }
    }
    return out.toString(StandardCharsets.UTF_8);
  }
}
