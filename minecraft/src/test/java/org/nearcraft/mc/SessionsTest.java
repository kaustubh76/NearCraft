package org.nearcraft.mc;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Who a connected player is acting as, and for how long.
 *
 * <p>Untested until now, which mattered most for {@link Sessions#unlink}: that
 * one method is the whole of this plugin's credential-lifetime claim — a
 * session id is bearer authority over a player's account, and the promise is
 * that it does not outlive the connection. A promise with no test is a comment.
 */
public final class SessionsTest {

  public static int run() {
    Harness h = new Harness("Sessions");
    System.out.println("\n--- Sessions ---");

    Sessions sessions = new Sessions();
    UUID alex = UUID.randomUUID();
    UUID robin = UUID.randomUUID();

    h.equals("a fresh store is empty", 0, sessions.size());
    h.check("an unknown player has no session", sessions.of(alex) == null);

    sessions.link(alex, new Sessions.Session("s-1", "p-aaa.testnet", List.of("buy_with_credit", "sell")));
    h.equals("a linked session comes back", "p-aaa.testnet", sessions.of(alex).accountId);
    h.equals("and carries its id", "s-1", sessions.of(alex).id);
    h.equals("the store counts it", 1, sessions.size());
    h.check("another player is still unknown", sessions.of(robin) == null);

    // Two players must not share one account by accident.
    sessions.link(robin, new Sessions.Session("s-2", "p-bbb.testnet", List.of("sell")));
    h.equals("a second player gets their own session", "p-bbb.testnet", sessions.of(robin).accountId);
    h.equals("the first is untouched", "p-aaa.testnet", sessions.of(alex).accountId);
    h.equals("both are counted", 2, sessions.size());

    // Re-linking replaces rather than duplicating: signing in again should not
    // leave the previous session reachable.
    sessions.link(alex, new Sessions.Session("s-3", "p-ccc.testnet", List.of("sell")));
    h.equals("signing in again replaces the session", "s-3", sessions.of(alex).id);
    h.equals("and does not add a second entry", 2, sessions.size());

    // ------------------------------------------------------ the whole claim
    Sessions.Session gone = sessions.unlink(alex);
    h.equals("unlink hands back what it removed", "s-3", gone.id);
    h.check("and the session is then unreachable", sessions.of(alex) == null);
    h.equals("the store shrinks", 1, sessions.size());
    h.check("unlinking twice is not an error", sessions.unlink(alex) == null);
    h.check("unlinking a stranger is not an error", sessions.unlink(UUID.randomUUID()) == null);
    h.equals("the other player keeps theirs", "p-bbb.testnet", sessions.of(robin).accountId);

    // --------------------------------------------------------- permissions
    //
    // The sole gate on the message that explains an immutable key. A `permits`
    // that answered true for anything would turn a clear refusal into a chain
    // error a player cannot read.
    Sessions.Session two = new Sessions.Session("s", "p", List.of("buy_with_credit", "sell"));
    h.check("a granted method is permitted", two.permits("sell"));
    h.check("another granted method is permitted", two.permits("buy_with_credit"));
    h.check("a method not granted is refused", !two.permits("invest_with_credit"));
    h.check("a method name is not matched loosely", !two.permits("sell_all"));
    h.check("the empty string is not permitted", !two.permits(""));
    h.check("null is not permitted", !two.permits(null));
    h.check("a session with no methods permits nothing", !new Sessions.Session("s", "p", null).permits("sell"));

    // The list must not be mutable by a caller: it is read from the chain, and
    // a caller that could add to it could grant itself a method.
    h.refuses("the permitted list cannot be added to", null,
        () -> two.permittedMethods.add("invest_with_credit"));

    h.equals("a three-method key permits investing", true,
        new Sessions.Session("s", "p", List.of("buy_with_credit", "sell", "invest_with_credit"))
            .permits("invest_with_credit"));

    // ------------------------------------------------------- the sign-in reply
    Sessions.Session read = Sessions.fromResponse(Json.asObject(Json.parse(
        "{\"sessionId\":\"s-9\",\"accountId\":\"p-1d6a3c5d.testnet\","
        + "\"permittedMethods\":[\"buy_with_credit\",\"sell\"],\"created\":false}")));
    h.equals("the account is read", "p-1d6a3c5d.testnet", read.accountId);
    h.equals("the session id is read", "s-9", read.id);
    h.equals("the method list survives in order", List.of("buy_with_credit", "sell"), read.permittedMethods);

    h.equals("a reply with no method list yields none", 0,
        Sessions.fromResponse(Json.asObject(Json.parse(
            "{\"sessionId\":\"s\",\"accountId\":\"p\"}"))).permittedMethods.size());
    h.equals("a method list that is not an array yields none", 0,
        Sessions.fromResponse(Json.asObject(Json.parse(
            "{\"sessionId\":\"s\",\"accountId\":\"p\",\"permittedMethods\":\"sell\"}"))).permittedMethods.size());

    // A reply without a session must not become a session that cannot act.
    h.refuses("a reply with no session id is refused", "carried no session",
        () -> Sessions.fromResponse(Json.asObject(Json.parse("{\"accountId\":\"p\"}"))));
    h.refuses("a reply with no account is refused", "carried no session",
        () -> Sessions.fromResponse(Json.asObject(Json.parse("{\"sessionId\":\"s\"}"))));
    h.refuses("an empty reply is refused", "carried no session",
        () -> Sessions.fromResponse(new LinkedHashMap<>()));
    h.refuses("an empty string session id is refused", "carried no session",
        () -> Sessions.fromResponse(Json.asObject(Json.parse("{\"sessionId\":\"\",\"accountId\":\"p\"}"))));

    // ------------------------------------------------------------- console
    h.equals("the console id is the nil uuid", new UUID(0L, 0L), Sessions.CONSOLE);
    h.check("which no real player is issued", !Sessions.CONSOLE.equals(UUID.randomUUID()));
    Sessions console = new Sessions();
    console.link(Sessions.CONSOLE, new Sessions.Session("s", "p-console", List.of("sell")));
    h.equals("the console can hold a session like anyone else", "p-console",
        console.of(Sessions.CONSOLE).accountId);

    return h.report();
  }
}
