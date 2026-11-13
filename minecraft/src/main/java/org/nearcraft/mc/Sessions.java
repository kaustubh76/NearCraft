package org.nearcraft.mc;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Which NEAR account each connected player is acting as.
 *
 * <p><b>Memory only, and never written to disk.</b> A session id is bearer
 * authority over a player's account on the play service: anything holding one
 * can spend that player's credit until the service restarts. Persisting them
 * would turn a game server's data folder — which operators copy, zip and share
 * when they ask for help with a crash — into a credential store. So a server
 * restart means signing in again, which is a small cost for a demo and the
 * right default for the thing it would otherwise leak.
 *
 * <p>Concurrent because commands arrive on the main thread while the HTTP
 * replies that create sessions land on scheduler threads.
 */
public final class Sessions {

  /**
   * The console's stand-in player id.
   *
   * <p>The console is not a player and has no {@link UUID}, but it is the only
   * way this loop can be driven on a machine with no Minecraft account — so it
   * gets a reserved, all-zero id rather than a separate code path. The nil UUID
   * is not issued to real accounts.
   */
  public static final UUID CONSOLE = new UUID(0L, 0L);

  /** What the service said when it handed this session out. */
  public static final class Session {
    public final String id;
    public final String accountId;
    /** Read from the chain by the service, not from configuration. */
    public final List<String> permittedMethods;

    public Session(String id, String accountId, List<String> permittedMethods) {
      this.id = id;
      this.accountId = accountId;
      this.permittedMethods = permittedMethods == null ? List.of() : List.copyOf(permittedMethods);
    }

    /**
     * Whether the key behind this account may call a method at all.
     *
     * <p>The null guard is not defensive padding: {@code List.of(...)} throws
     * on {@code contains(null)}, so without it a null method name crashed the
     * command handler instead of refusing the call. Found by the first test
     * ever written for this class.
     */
    public boolean permits(String method) {
      return method != null && permittedMethods.contains(method);
    }
  }

  private final Map<UUID, Session> byPlayer = new ConcurrentHashMap<>();

  public void link(UUID player, Session session) { byPlayer.put(player, session); }

  /** The session for a player, or null when they have not signed in. */
  public Session of(UUID player) { return byPlayer.get(player); }

  /** Forget a player's session. Called on quit, so a session does not outlive the connection. */
  public Session unlink(UUID player) { return byPlayer.remove(player); }

  public int size() { return byPlayer.size(); }

  /** Read a session out of a sign-in response. */
  public static Session fromResponse(Map<String, Object> body) {
    String id = Json.text(body, "sessionId", "");
    String account = Json.text(body, "accountId", "");
    if (id.isEmpty() || account.isEmpty()) {
      throw new Json.JsonException("sign-in response carried no session", 0);
    }
    Object methods = body.get("permittedMethods");
    List<String> permitted = List.of();
    if (methods instanceof List) {
      permitted = Json.asList(methods).stream().map(String::valueOf).toList();
    }
    return new Session(id, account, permitted);
  }
}
