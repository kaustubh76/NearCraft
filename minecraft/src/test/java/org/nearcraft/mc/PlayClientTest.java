package org.nearcraft.mc;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * Every route driven against a stub HTTP server.
 *
 * <p>No Minecraft and no NEAR: {@link PlayClient} holds no Bukkit types for
 * exactly this reason, so the transport can be proven on its own and the only
 * thing left to find on a real server is whether the plugin loads.
 */
public final class PlayClientTest {

  /** The last request the stub saw, so a test can assert what was actually sent. */
  static volatile String lastPath;
  static volatile String lastMethod;
  static volatile String lastBody;

  private static int status = 200;
  private static String reply = "{}";

  public static int run() throws IOException {
    Harness h = new Harness("PlayClient");
    System.out.println("\n--- PlayClient ---");

    // ------------------------------------------------- the address is checked
    //
    // A session id is bearer authority over a player's account. These two
    // refusals are the only thing standing between that and a clear-text hop
    // across someone's network.
    h.refuses("plain http to a remote host", "refusing plain http",
        () -> new PlayClient("http://play.example.com:8080"));
    h.refuses("a non-http scheme", "must be http or https",
        () -> new PlayClient("ftp://127.0.0.1:8080"));
    h.refuses("an empty address", "no service address", () -> new PlayClient("  "));
    // Two shapes of the same mistake, refused for two different reasons: a
    // scheme may not start with a digit, so Java rejects the first as not a URL
    // at all, while the second parses with scheme "localhost".
    h.refuses("a bare ip and port", "not a URL", () -> new PlayClient("127.0.0.1:8080"));
    h.refuses("a bare host and port", "must be http or https", () -> new PlayClient("localhost:8080"));
    h.equals("https to a remote host is allowed", "https://play.example.com",
        PlayClient.normaliseBase("https://play.example.com"));
    h.equals("a trailing slash is stripped", "http://127.0.0.1:8080",
        PlayClient.normaliseBase("http://127.0.0.1:8080/"));
    h.equals("localhost counts as loopback", "http://localhost:8080",
        PlayClient.normaliseBase("http://localhost:8080"));

    HttpServer server = null;
    try {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.createContext("/", PlayClientTest::handle);
      server.start();
      int port = server.getAddress().getPort();
      PlayClient client = new PlayClient("http://127.0.0.1:" + port);

      // `base()` is what every refusal message quotes back to a player, so a
      // wrong one sends them to look at the wrong port.
      h.equals("base reports the address it will use", "http://127.0.0.1:" + port, client.base());

      // ------------------------------------------------------------- reads
      status = 200;
      reply = "{\"materials\":[\"iron_ingot\",\"oak_log\",\"stone\"]}";
      PlayClient.Response materials = client.materials();
      h.check("materials succeeds", materials.ok());
      h.equals("materials reaches the right path", "/api/materials", lastPath);
      h.equals("and lists what the chain trades", 3, Json.asList(materials.body.get("materials")).size());
      h.equals("in the order given", "iron_ingot",
          String.valueOf(Json.asList(materials.body.get("materials")).get(0)));

      status = 200;
      reply = "{\"playable\":true,\"verifier\":\"seed\",\"network\":\"testnet\",\"custodial\":true}";
      PlayClient.Response health = client.health();
      h.check("health succeeds", health.ok());
      h.equals("health reaches the right path", "/api/health", lastPath);
      h.equals("health is a GET", "GET", lastMethod);
      h.equals("health reports the verifier", "seed", Json.text(health.body, "verifier", ""));

      reply = "{\"item\":\"iron_ingot\",\"merchants\":[{\"name\":\"Ironmonger\",\"ask\":\"0.004\","
          + "\"buying\":true,\"reason\":\"stock is deep\"}]}";
      PlayClient.Response market = client.market("iron_ingot", 2);
      h.check("market succeeds", market.ok());
      // Query parameters, because serve-play.mjs merges searchParams into the
      // body for GETs. Sending these as a JSON body would silently read nothing.
      h.equals("market sends its arguments as query parameters",
          "/api/market?item=iron_ingot&count=2", lastPath);
      h.equals("a merchant row survives", "Ironmonger",
          Json.text(Json.asObject(Json.asList(market.body.get("merchants")).get(0)), "name", ""));

      client.me("sess-1");
      h.equals("me carries the session id", "/api/me?sessionId=sess-1", lastPath);

      // ------------------------------------------------------------ writes
      reply = "{\"sessionId\":\"s-9\",\"accountId\":\"p-1.testnet\",\"permittedMethods\":[\"sell\"]}";
      PlayClient.Response signIn = client.signIn("seed:player-1");
      h.equals("sign-in is a POST to the session route", "/api/session", lastPath);
      h.equals("sign-in is a POST", "POST", lastMethod);
      h.equals("the token is sent in the body", "{\"token\":\"seed:player-1\"}", lastBody);
      h.equals("a session can be read out of the reply", "p-1.testnet",
          Sessions.fromResponse(signIn.body).accountId);

      reply = "{\"hash\":\"abc\",\"playerNearDelta\":\"0\"}";
      client.buy("s-9", "ironmonger", "iron_ingot", 3);
      h.equals("buy posts to the buy route", "/api/buy", lastPath);
      // count must be a JSON number. The service does Number(body.count), so a
      // string would still work there — but the approval id taught this project
      // that guessing a field's JSON type is how a call gets refused on chain.
      h.equals("buy sends count as a number, not a string",
          "{\"sessionId\":\"s-9\",\"merchantId\":\"ironmonger\",\"item\":\"iron_ingot\",\"count\":3}", lastBody);

      client.sell("s-9", "ironmonger", "iron_ingot", 1);
      h.equals("sell posts to the sell route", "/api/sell", lastPath);
      // The approval id is never sent: the service reads it off the chain, so a
      // caller cannot name someone else's grant.
      h.check("sell does not send an approval id", !lastBody.contains("approval"));

      reply = "{\"sessionId\":\"s-10\",\"accountId\":\"p-1.testnet\",\"permittedMethods\":[\"sell\"]}";
      PlayClient.Response claimed = client.claim("K9FH2MQ7");
      h.equals("claim posts to the link route", "/api/link", lastPath);
      h.equals("and sends only the code", "{\"code\":\"K9FH2MQ7\"}", lastBody);
      h.check("a claimed session is usable", claimed.ok());
      h.equals("and carries the account", "p-1.testnet",
          Sessions.fromResponse(claimed.body).accountId);

      client.invest("s-9", "ironmonger", "1000");
      h.equals("invest sends the amount as a string",
          "{\"sessionId\":\"s-9\",\"merchantId\":\"ironmonger\",\"amount\":\"1000\"}", lastBody);

      // --------------------------------------------------------- refusals
      status = 403;
      reply = "{\"error\":\"METHOD_NOT_PERMITTED\",\"detail\":\"the key grants buy_with_credit, sell\"}";
      PlayClient.Response refused = client.invest("s-9", "ironmonger", "1");
      h.check("a 403 is not reported as success", !refused.ok());
      h.equals("the service's error code survives", "METHOD_NOT_PERMITTED", refused.error());
      h.check("the reason is printable", refused.refusal().contains("buy_with_credit"));

      // A relayed call whose inner receipt panicked comes back as 502. The web
      // client learned this the hard way: the outer transaction succeeds.
      status = 502;
      reply = "{\"error\":\"INNER_CALL_FAILED\",\"detail\":\"Smart contract panicked: not enough credit\"}";
      PlayClient.Response panicked = client.buy("s-9", "ironmonger", "iron_ingot", 99);
      h.check("a panicked inner call is not success", !panicked.ok());
      h.equals("the panic is reported", "INNER_CALL_FAILED", panicked.error());

      status = 200;
      reply = "<!doctype html><html>not json</html>";
      PlayClient.Response html = client.health();
      h.equals("a non-JSON answer is its own failure", "BAD_RESPONSE", html.error());

      reply = "[1,2,3]";
      h.equals("a JSON array where an object was expected is refused", "BAD_RESPONSE", client.health().error());

      status = 200;
      reply = "{\"pad\":\"" + "x".repeat(Json.MAX_LENGTH + 16) + "\"}";
      PlayClient.Response huge = client.health();
      h.equals("an oversized body is refused rather than buffered", "SERVICE_UNREACHABLE", huge.error());

      server.stop(0);
      server = null;

      // With nothing listening, every route must refuse in a way a player can
      // act on rather than throwing out of a command handler.
      PlayClient.Response down = client.health();
      h.equals("an unreachable service answers with status 0", 0, down.status);
      h.equals("an unreachable service is named as such", "SERVICE_UNREACHABLE", down.error());
      h.check("the refusal says how to fix it", down.detail().contains("npm run play"));

      // No catch: if the stub server cannot start there is nothing to test, and
      // a check that reports that as a failed assertion would be counted as a
      // check that ran. It did not. Let it propagate and kill the run.
    } finally {
      if (server != null) server.stop(0);
    }

    return h.report();
  }

  private static void handle(HttpExchange exchange) throws IOException {
    lastMethod = exchange.getRequestMethod();
    String query = exchange.getRequestURI().getQuery();
    lastPath = exchange.getRequestURI().getPath() + (query == null ? "" : "?" + query);
    lastBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    byte[] out = reply.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().add("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, out.length);
    exchange.getResponseBody().write(out);
    exchange.close();
  }
}
