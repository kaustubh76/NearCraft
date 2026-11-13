package org.nearcraft.mc;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * NearCraft — settlement on NEAR, from inside Minecraft.
 *
 * <p>Buying iron puts a real iron ingot in a player's inventory and moves the
 * material on a NEP-245 contract on NEAR testnet. Selling takes the stack back
 * and pays credit in. The player's NEAR balance moves by exactly zero either
 * way, because the call travels as a NEP-366 delegate action that a relayer
 * pays for.
 *
 * <p><b>What this plugin is not.</b> It is not a port of EthCraft's Paper
 * plugin — that is 5,201 lines of world, menus, escrow, voice and property
 * protection whose order flow is EVM-shaped down to a hard-coded chain id, and
 * none of it is vendored or copied here. This is a new, small client of the
 * NearCraft play service, written to make one claim checkable: that the
 * settlement path reaches a public chain from inside the game.
 *
 * <p><b>No key is in this process.</b> Every write goes to the play service,
 * which holds the player's function-call key. That key cannot transfer NEAR
 * and cannot add another key — the runtime enforces both — so the worst a
 * compromised game server can do is spend a player's in-game credit on the one
 * contract their key names. {@code /wallet} prints that fact read back from the
 * chain rather than asserting it.
 */
public final class NearCraftPlugin extends JavaPlugin implements Listener {

  private static final String GOLD = "§6";
  private static final String GREY = "§7";
  private static final String GREEN = "§a";
  private static final String RED = "§c";
  private static final String AQUA = "§b";
  private static final String WHITE = "§f";
  private static final String RESET = "§r";

  private PlayClient client;
  private final Sessions sessions = new Sessions();

  @Override
  public void onEnable() {
    saveDefaultConfig();
    String service = getConfig().getString("service", "http://127.0.0.1:8080");
    try {
      client = new PlayClient(service);
    } catch (IllegalArgumentException e) {
      // A bad address is a configuration error, not a runtime one. Refuse to
      // enable rather than let every command fail later with the same message.
      getLogger().severe("NearCraft is not configured: " + e.getMessage());
      getServer().getPluginManager().disablePlugin(this);
      return;
    }
    getServer().getPluginManager().registerEvents(this, this);
    getLogger().info("settling through " + client.base() + " — this plugin holds no keys");
  }

  @Override
  public void onDisable() {
    // Sessions were never on disk; this only makes the lifetime explicit.
    getLogger().info("stopped; " + sessions.size() + " session(s) forgotten");
  }

  /** A session must not outlive the connection that created it. */
  @EventHandler
  public void onQuit(PlayerQuitEvent event) {
    sessions.unlink(event.getPlayer().getUniqueId());
  }

  // -------------------------------------------------------------- commands

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    switch (command.getName().toLowerCase()) {
      case "nearcraft": return nearcraft(sender, args);
      case "market": return market(sender, args);
      case "buy": return trade(sender, args, true);
      case "sell": return trade(sender, args, false);
      case "wallet": return wallet(sender);
      default: return false;
    }
  }

  private boolean nearcraft(CommandSender sender, String[] args) {
    String sub = args.length > 0 ? args[0].toLowerCase() : "help";
    switch (sub) {
      case "link": return link(sender, args);
      case "status": return status(sender);
      case "selftest": return selftest(sender);
      default:
        sender.sendMessage(GOLD + "NearCraft" + GREY + " — an agent economy settled on NEAR");
        sender.sendMessage(GREY + "  /nearcraft link <token>" + WHITE + "  sign in; no seed phrase, no wallet");
        sender.sendMessage(GREY + "  /market <item> [count]" + WHITE + "  what the merchants are quoting");
        sender.sendMessage(GREY + "  /buy <merchant> <item> [count]");
        sender.sendMessage(GREY + "  /sell <merchant> <item> [count]");
        sender.sendMessage(GREY + "  /wallet" + WHITE + "  credit, holdings, and what your key may do");
        return true;
    }
  }

  /**
   * Sign in.
   *
   * <p>The token is a command argument, which is the weak point of this whole
   * plugin and is disclosed rather than hidden: in seeded demo mode it is a
   * subject like {@code seed:player-1} and worth nothing, but pointed at a real
   * OIDC provider it would be a bearer JWT typed into a game client. It is
   * never written to disk and never logged here. The right fix is a one-time
   * code completed in the browser, and it is not built.
   */
  private boolean link(CommandSender sender, String[] args) {
    if (args.length < 2) {
      sender.sendMessage(RED + "usage: /nearcraft link <token>");
      return true;
    }
    String token = args[1];
    UUID who = idOf(sender);
    sender.sendMessage(GREY + "signing in...");
    async(() -> {
      PlayClient.Response response = client.signIn(token);
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "sign-in refused: " + response.refusal());
          return;
        }
        Sessions.Session session;
        try {
          session = Sessions.fromResponse(response.body);
        } catch (RuntimeException e) {
          sender.sendMessage(RED + "the service answered with no session: " + e.getMessage());
          return;
        }
        sessions.link(who, session);
        boolean created = Json.flag(response.body, "created", false);
        long fullAccess = Json.number(response.body, "fullAccessKeys", -1);
        sender.sendMessage(GREEN + "signed in as " + AQUA + session.accountId
            + GREY + (created ? " (account created for you)" : ""));
        sender.sendMessage(GREY + "  verifier " + WHITE + Json.text(response.body, "verifier", "?")
            + GREY + "   key may call " + WHITE + String.join(", ", session.permittedMethods));
        if (fullAccess == 0) {
          sender.sendMessage(GREY + "  full-access keys on your account: " + GREEN + "0"
              + GREY + " — nothing can transfer your NEAR or add a key, not even this server");
        }
      });
    });
    return true;
  }

  private boolean status(CommandSender sender) {
    sender.sendMessage(GREY + "service " + WHITE + client.base());
    async(() -> {
      PlayClient.Response response = client.health();
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "service unreachable: " + response.refusal());
          return;
        }
        sender.sendMessage(GREY + "  network " + WHITE + Json.text(response.body, "network", "?")
            + GREY + "  verifier " + WHITE + Json.text(response.body, "verifier", "?")
            + GREY + "  custodial " + WHITE + Json.flag(response.body, "custodial", false));
        Object contracts = response.body.get("contracts");
        if (contracts instanceof Map) {
          for (Map.Entry<String, Object> e : Json.asObject(contracts).entrySet()) {
            sender.sendMessage(GREY + "  " + e.getKey() + " " + WHITE + e.getValue());
          }
        }
        Sessions.Session mine = sessions.of(idOf(sender));
        sender.sendMessage(GREY + "  you are " + WHITE + (mine == null ? "not signed in" : mine.accountId));
      });
    });
    return true;
  }

  /**
   * Prove the whole path from the console, where there is no Player object.
   *
   * <p>This exists because this machine has no Minecraft account: without it
   * the only way to exercise the plugin would be to join the server, and the
   * claim would rest on a screenshot. It reads health and a live quote, which
   * is enough to show the plugin is talking to the chain through the service.
   */
  private boolean selftest(CommandSender sender) {
    sender.sendMessage(GOLD + "--- NearCraft selftest ---");
    async(() -> {
      PlayClient.Response health = client.health();
      PlayClient.Response quotes = client.market("iron_ingot", 1);
      sync(() -> {
        sender.sendMessage(GREY + "health  " + WHITE + health.status + " "
            + (health.ok() ? Json.text(health.body, "network", "?") + " via " + Json.text(health.body, "rpc", "?")
                           : health.refusal()));
        if (quotes.ok()) renderQuotes(sender, quotes, "iron_ingot");
        else sender.sendMessage(RED + "market  " + quotes.refusal());
        Sessions.Session mine = sessions.of(idOf(sender));
        sender.sendMessage(GREY + "session " + WHITE + (mine == null ? "none — /nearcraft link <token>" : mine.accountId));
        sender.sendMessage(GOLD + "--- end selftest ---");
      });
    });
    return true;
  }

  private boolean market(CommandSender sender, String[] args) {
    String item = args.length > 0 ? args[0].toLowerCase() : "iron_ingot";
    int count = count(args, 1);
    async(() -> {
      PlayClient.Response response = client.market(item, count);
      sync(() -> {
        if (!response.ok()) { sender.sendMessage(RED + "market: " + response.refusal()); return; }
        renderQuotes(sender, response, item);
      });
    });
    return true;
  }

  /** Print the merchant rows, each with the reason string the contract itself returned. */
  private void renderQuotes(CommandSender sender, PlayClient.Response response, String item) {
    List<Object> merchants = response.body.get("merchants") instanceof List
        ? Json.asList(response.body.get("merchants")) : List.of();
    if (merchants.isEmpty()) {
      sender.sendMessage(GREY + "no merchant is quoting " + WHITE + item);
      return;
    }
    sender.sendMessage(GOLD + item + GREY + " - " + merchants.size() + " merchant(s)");
    for (Object row : merchants) {
      if (!(row instanceof Map)) { sender.sendMessage(GREY + "  " + row); continue; }
      Map<String, Object> m = Json.asObject(row);
      sender.sendMessage(GREY + "  " + WHITE + handle(m)
          + GREY + "  asks " + AQUA + Amounts.near(Json.text(m, "unitPrice", "0"))
          + GREY + "  bids " + AQUA + Amounts.near(Json.text(m, "bid", "0"))
          + GREY + "  stock " + WHITE + Json.number(m, "stock", 0)
          + (Json.flag(m, "buying", false) ? GREY + "  " + GREEN + "buying" : GREY + "  " + RED + "not buying"));
      String reason = Json.text(m, "reason", "");
      // The contract's own sentence, not a restatement of it. This is the one
      // thing a player can read that came from the chain rather than from here.
      if (!reason.isEmpty()) sender.sendMessage(GREY + "    " + reason);
    }
    sender.sendMessage(GREY + "  prices in NEAR; trade with " + WHITE + "/buy <merchant> " + item);
  }

  /** The short name a player types, taken from the account id the chain uses. */
  private static String handle(Map<String, Object> row) {
    String id = Json.text(row, "merchantId", "");
    int dot = id.indexOf('.');
    String short_ = dot > 0 ? id.substring(0, dot) : id;
    String name = Json.text(row, "merchantName", short_);
    return short_.isEmpty() ? name : name + " (" + short_ + ")";
  }

  /**
   * Find the merchant a player meant.
   *
   * <p>The chain knows merchants as {@code ironmonger.nearcraftmc.testnet}.
   * Nobody is typing that into a chat box mid-game, so the short handle, the
   * display name and the full id all resolve, and an unknown one is answered
   * with the list rather than a refusal the player cannot act on.
   */
  private static Map<String, Object> matchMerchant(PlayClient.Response quotes, String wanted) {
    if (!(quotes.body.get("merchants") instanceof List)) return null;
    String target = wanted.trim().toLowerCase();
    for (Object row : Json.asList(quotes.body.get("merchants"))) {
      if (!(row instanceof Map)) continue;
      Map<String, Object> m = Json.asObject(row);
      String id = Json.text(m, "merchantId", "").toLowerCase();
      String name = Json.text(m, "merchantName", "").toLowerCase();
      if (id.equals(target) || name.equals(target) || id.startsWith(target + ".")) return m;
    }
    return null;
  }

  /**
   * Buy or sell.
   *
   * <p>Order of operations, and why. A sale takes the stack <i>before</i> the
   * chain call and gives it back if anything refuses. Taking after would let
   * the same stack be sold twice by two commands in flight, and the chain would
   * settle both. A refund is visible and bounded; a double sale is neither.
   *
   * <p>A purchase is the other way round: the chain settles first and the stack
   * appears after, because there is nothing to hold in escrow until it does.
   *
   * <p>Threading: validation and every inventory touch happen on the main
   * thread, and the two network calls happen off it. A synchronous HTTP call in
   * a command handler would freeze the world for every player on the server.
   */
  private boolean trade(CommandSender sender, String[] args, boolean buying) {
    String verb = buying ? "buy" : "sell";
    if (args.length < 2) {
      sender.sendMessage(RED + "usage: /" + verb + " <merchant> <item> [count]");
      return true;
    }
    String wanted = args[0];
    String item = args[1].toLowerCase();
    int count = count(args, 2);
    Sessions.Session session = sessions.of(idOf(sender));
    if (session == null) {
      sender.sendMessage(RED + "sign in first: " + WHITE + "/nearcraft link <token>");
      return true;
    }
    String method = buying ? "buy_with_credit" : "sell";
    if (!session.permits(method)) {
      // The key is immutable for life: no full-access key remains on the account
      // that could add a method. Say so here rather than letting the chain
      // refuse it a second later with less explanation.
      sender.sendMessage(RED + "your key may not call " + WHITE + method
          + RED + " - it grants " + WHITE + String.join(", ", session.permittedMethods)
          + RED + " and can never gain another: the account has no full-access key.");
      return true;
    }

    Material material = Items.materialFor(item);
    if (material == null) {
      sender.sendMessage(RED + "this game has no block called " + WHITE + item);
      return true;
    }

    // The console has no inventory. One code path; the missing half is named.
    Player player = sender instanceof Player ? (Player) sender : null;
    if (!buying && player != null && !Items.take(player, material, count)) {
      sender.sendMessage(RED + "you are carrying " + Items.held(player, material)
          + " " + item + ", not " + count);
      return true;
    }
    Runnable refund = () -> {
      if (!buying && player != null) {
        Items.give(player, material, count);
        sender.sendMessage(GREY + "  your " + count + " " + item + " came back");
      }
    };

    sender.sendMessage(GREY + (buying ? "buying " : "selling ") + count + " " + item + "...");
    async(() -> {
      PlayClient.Response quotes = client.market(item, count);
      if (!quotes.ok()) {
        sync(() -> { sender.sendMessage(RED + "market: " + quotes.refusal()); refund.run(); });
        return;
      }
      Map<String, Object> row = matchMerchant(quotes, wanted);
      if (row == null) {
        sync(() -> {
          sender.sendMessage(RED + "no merchant called " + WHITE + wanted + RED + " trades " + item);
          renderQuotes(sender, quotes, item);
          refund.run();
        });
        return;
      }
      String merchantId = Json.text(row, "merchantId", wanted);
      String shown = handle(row);
      if (Json.flag(row, "closed", false)) {
        sync(() -> { sender.sendMessage(RED + shown + " is closed"); refund.run(); });
        return;
      }
      if (!buying && !Json.flag(row, "buying", false)) {
        // The contract decides this, and it already said why.
        sync(() -> {
          sender.sendMessage(RED + shown + " is not buying " + item);
          sender.sendMessage(GREY + "  " + Json.text(row, "reason", ""));
          refund.run();
        });
        return;
      }

      PlayClient.Response response = buying
          ? client.buy(session.id, merchantId, item, count)
          : client.sell(session.id, merchantId, item, count);
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + verb + " refused: " + response.refusal());
          refund.run();
          return;
        }
        if (buying && player != null) Items.give(player, material, count);
        String hash = Json.text(response.body, "hash", "?");
        String delta = Json.text(response.body, "playerNearDelta", "0");
        sender.sendMessage(GREEN + "settled on NEAR" + GREY + " with " + WHITE + shown
            + GREY + "  tx " + WHITE + hash);
        sender.sendMessage(GREY + "  your NEAR balance moved by " + WHITE + Amounts.near(delta)
            + GREY + ("0".equals(delta) ? " - the relayer paid the gas" : ""));
        if (player == null) sender.sendMessage(GREY + "  (console: chain only, no inventory to move)");
      });
    });
    return true;
  }

  private boolean wallet(CommandSender sender) {
    Sessions.Session session = sessions.of(idOf(sender));
    if (session == null) {
      sender.sendMessage(RED + "sign in first: " + WHITE + "/nearcraft link <token>");
      return true;
    }
    async(() -> {
      PlayClient.Response response = client.me(session.id);
      sync(() -> {
        if (!response.ok()) { sender.sendMessage(RED + "wallet: " + response.refusal()); return; }
        sender.sendMessage(GOLD + Json.text(response.body, "accountId", session.accountId));
        sender.sendMessage(GREY + "  credit " + WHITE + Amounts.nearWithUnit(Json.text(response.body, "credit", "0"))
            + GREY + " of spend budget, set by the market contract");
        sender.sendMessage(GREY + "  NEAR   " + WHITE + Amounts.nearWithUnit(Json.text(response.body, "near", "0"))
            + GREY + " - gas is never taken from this");
        Object holdings = response.body.get("holdings");
        int shown = 0;
        if (holdings instanceof Map) {
          for (Map.Entry<String, Object> e : Json.asObject(holdings).entrySet()) {
            if ("0".equals(String.valueOf(e.getValue()))) continue;
            sender.sendMessage(GREY + "  holds  " + WHITE + e.getValue() + " " + e.getKey());
            shown++;
          }
        }
        // Say it rather than printing nothing. Skipping the line entirely left a
        // console transcript where a player who had just sold their last ingot
        // appeared to have no holdings field at all, which reads like a bug in
        // the service rather than an empty inventory.
        if (shown == 0) sender.sendMessage(GREY + "  holds  " + WHITE + "nothing");
        sender.sendMessage(GREY + "  key may call " + WHITE + String.join(", ", session.permittedMethods));
        sender.sendMessage(GREY + "  full-access keys " + WHITE + Json.number(response.body, "fullAccessKeys", -1)
            + GREY + "   scoped keys " + WHITE + Json.number(response.body, "scopedKeys", -1)
            + RESET);
      });
    });
    return true;
  }

  // --------------------------------------------------------------- helpers

  /** The console is not a player, so it borrows a reserved id rather than a branch. */
  private static UUID idOf(CommandSender sender) {
    return sender instanceof Player ? ((Player) sender).getUniqueId() : Sessions.CONSOLE;
  }

  private static int count(String[] args, int index) {
    if (args.length <= index) return 1;
    try {
      // Bounded at both ends: zero is not an order, and a stack is 64.
      return Math.max(1, Math.min(64, Integer.parseInt(args[index].trim())));
    } catch (NumberFormatException e) {
      return 1;
    }
  }

  /**
   * Run off the main thread.
   *
   * <p>Not an optimisation. A relayed call takes seconds, and the main thread
   * is the one that ticks the world — a synchronous HTTP call in a command
   * handler freezes every player on the server until it returns.
   */
  private void async(Runnable work) {
    if (!isEnabled()) return;
    getServer().getScheduler().runTaskAsynchronously(this, work);
  }

  /** Back to the main thread, which is the only one allowed to touch an inventory. */
  private void sync(Runnable work) {
    if (!isEnabled()) return;
    getServer().getScheduler().runTask(this, work);
  }
}
