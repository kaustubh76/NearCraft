package org.nearcraft.mc;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
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
      case "invest": return invest(sender, args);
      case "agent": return agent(sender, args);
      default: return false;
    }
  }

  private boolean nearcraft(CommandSender sender, String[] args) {
    String sub = args.length > 0 ? args[0].toLowerCase() : "help";
    switch (sub) {
      case "link": return link(sender, args);
      case "status": return status(sender);
      case "selftest": return selftest(sender);
      case "claim": return claim(sender, args);
      case "inventory-selftest": return inventorySelftest(sender);
      case "world-selftest": return worldSelftest(sender);
      default:
        // Every subcommand, because the help listed exactly one of the four and
        // the rest were discoverable only by reading the source.
        sender.sendMessage(GOLD + "NearCraft" + GREY + " — an agent economy settled on NEAR");
        sender.sendMessage(GREY + "  /nearcraft link <token>" + WHITE + "  sign in; no seed phrase, no wallet");
        sender.sendMessage(GREY + "  /nearcraft claim <code>" + WHITE + "  sign in with a code from the web page");
        sender.sendMessage(GREY + "  /nearcraft status" + WHITE + "  which chain and which login this server uses");
        sender.sendMessage(GREY + "  /nearcraft selftest" + WHITE + "  reach the service and read live prices");
        sender.sendMessage(GREY + "  /nearcraft inventory-selftest" + WHITE + "  check the block arithmetic");
        sender.sendMessage(GREY + "  /nearcraft world-selftest" + WHITE + "  can the traded materials be gathered here");
        sender.sendMessage(GREY + "  /market" + WHITE + "  what this economy trades");
        sender.sendMessage(GREY + "  /market <item> [count]" + WHITE + "  what the merchants are quoting");
        sender.sendMessage(GREY + "  /buy <merchant> <item> [count]");
        sender.sendMessage(GREY + "  /sell <merchant> <item> [count]");
        sender.sendMessage(GREY + "  /wallet" + WHITE + "  credit, holdings, and what your key may do");
        sender.sendMessage(GREY + "  /invest <merchant> <NEAR>" + WHITE + "  reopen a merchant that went broke");
        sender.sendMessage(GREY + "  /agent <worker> buy <item> [count]" + WHITE + "  send an agent shopping on its own budget");
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

    // A real identity token cannot get here, so say so rather than sending it.
    //
    // A Google id token is about 977 characters; Minecraft carries 256. What
    // arrives is a truncated credential, and the service would reject it with a
    // parse error that tells the player nothing about why. Worse, the fragment
    // would still have been typed into a chat box. The browser holds the token
    // and hands over an eight-character code instead.
    if (Orders.looksLikeJwt(token)) {
      sender.sendMessage(RED + "that looks like an identity token, and one cannot fit here.");
      sender.sendMessage(GREY + "  Minecraft carries " + WHITE + Orders.CHAT_LIMIT + GREY
          + " characters; a real login is about 977, so what arrives is a truncated credential.");
      sender.sendMessage(GREY + "  Sign in on the web page, press " + WHITE + "code for Minecraft"
          + GREY + ", then run " + WHITE + "/nearcraft claim <code>");
      return true;
    }

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

  /**
   * Sign in with a short code minted by a client that could hold the token.
   *
   * <p>This is the half of the login that Minecraft can actually carry. The
   * code is single-use, expires in two minutes and is attempt-capped by the
   * service; it is still a bearer credential for those two minutes, so it is
   * worth no more than reading it aloud on a stream would cost.
   */
  private boolean claim(CommandSender sender, String[] args) {
    if (args.length < 2) {
      sender.sendMessage(RED + "usage: /nearcraft claim <code>");
      sender.sendMessage(GREY + "  sign in on the web page and press " + WHITE + "code for Minecraft");
      return true;
    }
    String code = args[1];
    UUID who = idOf(sender);
    sender.sendMessage(GREY + "claiming...");
    async(() -> {
      PlayClient.Response response = client.claim(code);
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "that code did not work: " + response.refusal());
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
        sender.sendMessage(GREEN + "signed in as " + AQUA + session.accountId);
        sender.sendMessage(GREY + "  verifier " + WHITE + Json.text(response.body, "verifier", "?")
            + GREY + "   key may call " + WHITE + String.join(", ", session.permittedMethods));
        if (Json.number(response.body, "fullAccessKeys", -1) == 0) {
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
    // No item named: list what the chain actually trades, rather than guessing
    // at one. This is also the only caller of PlayClient.materials, which was
    // written, tested and reachable from nothing.
    if (args.length == 0) {
      async(() -> {
        PlayClient.Response response = client.materials();
        sync(() -> {
          if (!response.ok()) { sender.sendMessage(RED + "materials: " + response.refusal()); return; }
          Object list = response.body.get("materials");
          if (!(list instanceof List)) { sender.sendMessage(RED + "the service listed no materials"); return; }
          sender.sendMessage(GOLD + "this economy trades:");
          for (Object material : Json.asList(list)) {
            Material block = Items.materialFor(String.valueOf(material));
            sender.sendMessage(GREY + "  " + WHITE + material
                + (block == null ? RED + "  (no block in this game)" : ""));
          }
          sender.sendMessage(GREY + "  /market <item> [count]" + WHITE + " for prices");
        });
      });
      return true;
    }
    String item = args[0].toLowerCase();
    int count = Orders.count(args, 1);
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
      sender.sendMessage(GREY + "  " + WHITE + Orders.handle(m)
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
    int count = Orders.count(args, 2);
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
    if (!buying && player != null && !Items.take(player.getInventory(), material, count)) {
      sender.sendMessage(RED + "you are carrying " + Items.held(player.getInventory(), material)
          + " " + item + ", not " + count);
      return true;
    }
    Runnable refund = () -> {
      if (!buying && player != null) {
        Items.giveOrDrop(player, material, count);
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
      Map<String, Object> row = Orders.match(quotes, wanted);
      if (row == null) {
        sync(() -> {
          sender.sendMessage(RED + "no merchant called " + WHITE + wanted + RED + " trades " + item);
          renderQuotes(sender, quotes, item);
          refund.run();
        });
        return;
      }
      String merchantId = Json.text(row, "merchantId", wanted);
      String shown = Orders.handle(row);
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
        if (buying && player != null) Items.giveOrDrop(player, material, count);
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

  /**
   * Send a declared agent shopping.
   *
   * <p><b>Why this exists.</b> GAME_LOOP.md has described
   * {@code /agent worker task gather 64 iron} as a core mechanic since the
   * first draft, and nothing implemented it — no entry in plugin.yml, no
   * handler here. The agents were real on chain and drivable only from
   * {@code npm run agent} against a sandbox, so the one mechanic that makes
   * this an <i>agent</i> economy was the one a player could not reach.
   *
   * <p><b>What an agent is, and is not.</b> It is not the player's wallet with
   * a different label. {@code worker-1} holds its own NEAR account, its own
   * credit at the market and its own function-call key scoped to one method on
   * one contract. It pays its own gas — the relayer exists so that PLAYERS
   * never see a gas prompt, and an agent is not a player. The response says
   * whose account moved, because "you bought it" and "your agent bought it"
   * are different facts.
   *
   * <p>It does not gather. The documented verb was {@code task gather}, and
   * nothing here can make an agent mine a block; what it can do is spend its
   * budget at the market. GAME_LOOP.md now says that rather than the other.
   *
   * <p>No merchant argument: picking one is the shopping, and the point of
   * sending an agent is not to do the shopping yourself. {@link Orders#cheapest}
   * takes the cheapest row that will actually trade.
   */
  private boolean agent(CommandSender sender, String[] args) {
    if (args.length < 3 || !"buy".equalsIgnoreCase(args[1])) {
      sender.sendMessage(RED + "usage: /agent <worker> buy <item> [count]");
      sender.sendMessage(GREY + "  sends an agent shopping. It spends " + WHITE + "its own"
          + GREY + " credit and its own gas, not yours.");
      // Name the agents this deployment actually has rather than making a
      // player guess. The service is the only thing that knows.
      async(() -> {
        PlayClient.Response health = client.health();
        sync(() -> {
          if (!health.ok() || !(health.body.get("agents") instanceof List)) return;
          List<Object> rows = Json.asList(health.body.get("agents"));
          if (rows.isEmpty()) {
            sender.sendMessage(GREY + "  this deployment holds no agent keys, so none can be sent.");
            return;
          }
          StringBuilder names = new StringBuilder();
          for (Object row : rows) {
            if (!(row instanceof Map)) continue;
            if (names.length() > 0) names.append(", ");
            names.append(Json.text(Json.asObject(row), "name", "?"));
          }
          sender.sendMessage(GREY + "  available: " + WHITE + names);
        });
      });
      return true;
    }

    Sessions.Session session = sessions.of(idOf(sender));
    if (session == null) {
      // A session is required even though the agent's credit is spent and not
      // the player's: dispatching one costs that agent real gas, and an
      // anonymous caller does not get to spend it.
      sender.sendMessage(RED + "sign in first: " + WHITE + "/nearcraft link <token>");
      return true;
    }

    String worker = args[0];
    String item = args[2].toLowerCase();
    int count = Orders.count(args, 3);
    if (Items.materialFor(item) == null) {
      sender.sendMessage(RED + WHITE + item + RED + " is not a block this game has");
      return true;
    }

    sender.sendMessage(GREY + "sending " + WHITE + worker + GREY + " for " + count + " " + item + "...");
    async(() -> {
      PlayClient.Response quotes = client.market(item, count);
      if (!quotes.ok()) {
        sync(() -> sender.sendMessage(RED + "market: " + quotes.refusal()));
        return;
      }
      Map<String, Object> row = Orders.cheapest(quotes);
      if (row == null) {
        sync(() -> {
          sender.sendMessage(RED + "no merchant is selling " + WHITE + item + RED + " right now");
          sender.sendMessage(GREY + "  /market " + item + WHITE + " shows why, in the contract's own words");
        });
        return;
      }
      String merchantId = Json.text(row, "merchantId", "");
      String merchantName = Json.text(row, "merchantName", merchantId);
      PlayClient.Response response = client.agent(session.id, worker, merchantId, item, count);
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "the agent was not sent: " + response.refusal());
          return;
        }
        sender.sendMessage(GREEN + Json.text(response.body, "agentId", worker) + GREY + " bought "
            + WHITE + count + " " + item + GREY + " from " + WHITE + merchantName);
        sender.sendMessage(GREY + "  tx " + WHITE + Json.text(response.body, "hash", "?"));
        sender.sendMessage(GREY + "  spent from the agent's own credit, on its own key — "
            + "nothing came out of your wallet, and the blocks are the agent's too.");
      });
    });
    return true;
  }

  /**
   * Back a merchant that went broke, so it reopens.
   *
   * <p>This is the `games` prompt's own closing sentence — "it closes its shop
   * until someone invests in it" — and until now it was the one mechanic in
   * this project that was built end to end and reachable by nobody. The
   * contract has it, the service routes it, the relayer allows it, a new
   * player's key is granted it, and no client called it.
   *
   * <p>There are two invest methods and the difference decides whether a player
   * can do this at all. {@code invest} is {@code #[payable]} and takes a
   * deposit, which a function-call key cannot attach; {@code invest_with_credit}
   * is non-payable and spends the player's existing credit, which is the only
   * version a key-less player can reach. This calls the second.
   */
  private boolean invest(CommandSender sender, String[] args) {
    if (args.length < 2) {
      sender.sendMessage(RED + "usage: /invest <merchant> <amount in NEAR>");
      sender.sendMessage(GREY + "  backs a broke merchant out of your credit, so it reopens");
      return true;
    }
    String wanted = args[0];
    Sessions.Session session = sessions.of(idOf(sender));
    if (session == null) {
      sender.sendMessage(RED + "sign in first: " + WHITE + "/nearcraft link <token>");
      return true;
    }
    if (!session.permits("invest_with_credit")) {
      // Not a bug and not a bad request: this account's key was issued before
      // the method existed, and a key with no full-access sibling can never
      // gain one. The product says so rather than letting the chain refuse it.
      sender.sendMessage(RED + "your key may not call " + WHITE + "invest_with_credit");
      sender.sendMessage(GREY + "  it grants " + WHITE + String.join(", ", session.permittedMethods)
          + GREY + " and can never gain another: the account has no full-access key.");
      sender.sendMessage(GREY + "  a player onboarded today is granted all three.");
      return true;
    }

    String stake = Amounts.yocto(args[1]);
    if (stake == null) {
      sender.sendMessage(RED + WHITE + args[1] + RED + " is not an amount of NEAR this chain can hold");
      sender.sendMessage(GREY + "  24 decimal places is the smallest unit; nothing is rounded for you");
      return true;
    }
    if ("0".equals(stake)) {
      sender.sendMessage(RED + "a stake of nothing would reopen nothing");
      return true;
    }

    sender.sendMessage(GREY + "backing " + wanted + " with " + Amounts.nearWithUnit(stake) + " of credit...");
    async(() -> {
      // Investing names no item, so there is no quote list to resolve the
      // handle against — the merchant's account id is derived from the market
      // contract's, which shares its parent.
      PlayClient.Response health = client.health();
      String market = health.ok() && health.body.get("contracts") instanceof Map
          ? Json.text(Json.asObject(health.body.get("contracts")), "market", "")
          : "";
      String merchantId = Orders.merchantId(wanted, market);
      if (merchantId == null) {
        sync(() -> sender.sendMessage(RED + "cannot work out which account " + WHITE + wanted
            + RED + " is; give the full id"));
        return;
      }
      PlayClient.Response response = client.invest(session.id, merchantId, stake);
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "invest refused: " + response.refusal());
          return;
        }
        String delta = Json.text(response.body, "playerNearDelta", "0");
        sender.sendMessage(GREEN + "staked " + Amounts.nearWithUnit(stake) + GREY + " in " + WHITE + merchantId);
        sender.sendMessage(GREY + "  tx " + WHITE + Json.text(response.body, "hash", "?"));
        sender.sendMessage(GREY + "  your NEAR balance moved by " + WHITE + Amounts.near(delta)
            + GREY + ("0".equals(delta) ? " - the relayer paid the gas" : ""));
        // The contract repays a backer out of half of every later sale's
        // margin. Say that, because a stake that looked like a donation is the
        // reason nobody would ever make one.
        sender.sendMessage(GREY + "  half of every later sale's margin repays you until the claim is settled");
        sender.sendMessage(GREY + "  run " + WHITE + "/market <item>" + GREY + " to see the shop open again");
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

  /**
   * Can the materials this economy trades actually be gathered in this world?
   *
   * <p><b>Why this had to be written.</b> The server generated a default
   * superflat world — bedrock, two dirt, one grass — in survival mode. The
   * economy trades iron_ingot, oak_log, stone, glass, coal, copper_ingot,
   * oak_planks and redstone, and NOT ONE of those eight existed in the world a
   * player spawned into. So the first of the three core actions in
   * GAME_LOOP.md, "Mine, chop, or harvest one stack-worth of a material", could
   * not be performed at all: you could trade, but only things you had bought.
   * Nothing noticed for the same reason nothing ever notices this class of
   * defect — no code asked the world what was in it, so no answer could be
   * wrong.
   *
   * <p>The material list comes from the SERVICE, not from a constant here. The
   * chain decides what this economy trades, and a second copy of that list in
   * the plugin is one more thing to rot. The cost is that this check needs the
   * service up, which is the same thing every other command needs.
   *
   * <p>The scan runs on the main thread, deliberately: {@code getBlockAt} is
   * not safe off it. It reads the full height of a 49x49 column of already
   * loaded chunks — a few hundred thousand reads, which is a blink — and this
   * is a diagnostic rather than something in a player's way.
   *
   * <p>The bar is half the traded materials. It is not "all eight", because
   * distribution is real: sand is a beach, redstone is deep, and a world can be
   * entirely playable without either within 24 blocks of where you stand.
   * Against the old flat world this reports zero of eight and fails, which is
   * the comparison that matters.
   */
  private boolean worldSelftest(CommandSender sender) {
    async(() -> {
      PlayClient.Response response = client.materials();
      sync(() -> {
        if (!response.ok()) {
          sender.sendMessage(RED + "the service would not list the materials: " + response.refusal());
          sender.sendMessage(RED + "world selftest: 0 of 0 materials gatherable, 1 failed");
          return;
        }
        Object list = response.body.get("materials");
        if (!(list instanceof List)) {
          sender.sendMessage(RED + "the service listed no materials");
          sender.sendMessage(RED + "world selftest: 0 of 0 materials gatherable, 1 failed");
          return;
        }
        List<Object> materials = Json.asList(list);
        if (materials.isEmpty()) {
          sender.sendMessage(RED + "world selftest: 0 of 0 materials gatherable, 1 failed");
          return;
        }

        // A player stands somewhere; the console does not, so it asks about
        // spawn — which is where a player arriving would stand.
        Location centre;
        if (sender instanceof Player) {
          centre = ((Player) sender).getLocation();
        } else if (!Bukkit.getWorlds().isEmpty()) {
          centre = Bukkit.getWorlds().get(0).getSpawnLocation();
        } else {
          sender.sendMessage(RED + "world selftest: this server has no world, 1 failed");
          return;
        }
        World world = centre.getWorld();
        if (world == null) {
          sender.sendMessage(RED + "world selftest: that location has no world, 1 failed");
          return;
        }

        // One pass over the box, tallying only the blocks any material needs.
        // Scanning once per material would be eight passes for the same answer.
        Map<Material, Integer> seen = new LinkedHashMap<>();
        for (Object material : materials) {
          for (Material source : Items.sourcesFor(String.valueOf(material))) seen.putIfAbsent(source, 0);
        }

        // The FULL column, not a slab around the player. The first version
        // scanned fifty blocks down and reported redstone missing from a world
        // that has plenty of it — redstone generates below y=16 and spawn here
        // is at y=95, so the answer was about the box rather than about the
        // world. These chunks are already generated top to bottom, so reading
        // all of them costs no chunk loads, only about 430,000 array reads.
        int radius = 24;
        int minY = world.getMinHeight();
        int maxY = Math.min(world.getMaxHeight() - 1, centre.getBlockY() + 20);
        for (int x = centre.getBlockX() - radius; x <= centre.getBlockX() + radius; x++) {
          for (int z = centre.getBlockZ() - radius; z <= centre.getBlockZ() + radius; z++) {
            for (int y = minY; y <= maxY; y++) {
              Material type = world.getBlockAt(x, y, z).getType();
              Integer count = seen.get(type);
              if (count != null) seen.put(type, count + 1);
            }
          }
        }

        sender.sendMessage(GOLD + "--- NearCraft world selftest ---");
        sender.sendMessage(GREY + "  world " + WHITE + world.getName() + GREY + "  centred on " + WHITE
            + centre.getBlockX() + " " + centre.getBlockY() + " " + centre.getBlockZ()
            + GREY + "  box " + WHITE + (radius * 2 + 1) + "x" + (radius * 2 + 1) + "x" + (maxY - minY + 1));

        int gatherable = 0;
        for (Object material : materials) {
          String id = String.valueOf(material);
          List<Material> sources = Items.sourcesFor(id);
          int total = 0;
          StringBuilder where = new StringBuilder();
          for (Material source : sources) {
            int n = seen.getOrDefault(source, 0);
            total += n;
            if (n > 0) {
              if (where.length() > 0) where.append(", ");
              where.append(source.name().toLowerCase()).append(" x").append(n);
            }
          }
          if (total > 0) {
            gatherable++;
            sender.sendMessage(GREY + "  ok    " + WHITE + id + GREY + "  from " + where);
          } else {
            String names = sources.isEmpty() ? "nothing this plugin knows" : sources.toString().toLowerCase();
            sender.sendMessage(RED + "  none  " + id + "  no " + names + " within reach");
          }
        }

        int failed = gatherable * 2 < materials.size() ? 1 : 0;
        sender.sendMessage((failed == 0 ? GREEN : RED) + "world selftest: " + gatherable + " of "
            + materials.size() + " materials gatherable, " + failed + " failed");
        if (failed != 0) {
          sender.sendMessage(RED + "  this world cannot be played: there is nothing here to gather.");
          sender.sendMessage(RED + "  check level-type in server.properties — a default superflat world");
          sender.sendMessage(RED + "  is bedrock, two dirt and one grass, and holds none of these.");
        }
      });
    });
    return true;
  }

  /**
   * Check the inventory arithmetic against a REAL Bukkit inventory, from the
   * console, with nobody connected.
   *
   * <p>This exists because {@link Items} is the only code here that touches a
   * player's property, and for its whole first day it could not be exercised at
   * all: a {@code Player} cannot be constructed without a client, and the
   * console path skips the inventory branch. So the arithmetic ran nowhere.
   *
   * <p>{@code Bukkit.createInventory} gives a genuine server-side inventory —
   * the same interface and the same implementation family a player carries —
   * so this is not a mock. What it cannot cover is the offhand slot, which only
   * a player inventory has; {@code npm run mc:bot} covers that with a real one.
   */
  private boolean inventorySelftest(CommandSender sender) {
    sender.sendMessage(GOLD + "--- inventory selftest ---");
    int[] tally = new int[2]; // passed, failed
    Material iron = Material.IRON_INGOT;
    Material stone = Material.STONE;

    // Exact amount, in one stack.
    Inventory one = Bukkit.createInventory(null, 36);
    one.addItem(new ItemStack(iron, 10));
    check(sender, tally, "taking exactly what is there succeeds", Items.take(one, iron, 10));
    check(sender, tally, "and leaves nothing behind", Items.held(one, iron) == 0);

    // One short. THE case: Bukkit removes "as much as possible", so an
    // implementation that trusts removeItem without reading its return leaves
    // the player minus the blocks AND minus the sale.
    Inventory short_ = Bukkit.createInventory(null, 36);
    short_.addItem(new ItemStack(iron, 5));
    check(sender, tally, "taking more than is there is refused", !Items.take(short_, iron, 6));
    check(sender, tally, "and a refused take changes NOTHING", Items.held(short_, iron) == 5);

    // Spread across several stacks, which is how 100 iron is actually carried.
    Inventory spread = Bukkit.createInventory(null, 36);
    spread.addItem(new ItemStack(iron, 64));
    spread.addItem(new ItemStack(iron, 64));
    spread.addItem(new ItemStack(iron, 10));
    check(sender, tally, "a take spanning three stacks succeeds", Items.take(spread, iron, 100));
    check(sender, tally, "and takes exactly 100 of the 138", Items.held(spread, iron) == 38);

    // Nothing at all.
    check(sender, tally, "taking from an empty inventory is refused",
        !Items.take(Bukkit.createInventory(null, 36), iron, 1));

    // A nonsense order must not be treated as a successful no-op, because the
    // caller reads `true` as "the player has paid".
    check(sender, tally, "taking zero is refused", !Items.take(one, iron, 0));
    check(sender, tally, "taking a negative amount is refused", !Items.take(one, iron, -5));

    // A full inventory must hand the remainder BACK rather than void it: the
    // chain has already moved the material by the time this runs.
    Inventory full = Bukkit.createInventory(null, 36);
    for (int i = 0; i < 36; i++) full.setItem(i, new ItemStack(stone, 64));
    check(sender, tally, "a full inventory returns what would not fit",
        Items.give(full, iron, 5).stream().mapToInt(ItemStack::getAmount).sum() == 5);

    Inventory room = Bukkit.createInventory(null, 36);
    check(sender, tally, "an inventory with room returns no leftovers", Items.give(room, iron, 5).isEmpty());
    check(sender, tally, "and is now carrying them", Items.held(room, iron) == 5);

    // The token-id-to-block join, which `/market` and every trade depend on and
    // which nothing asserted. It needs the server's material registry, so this
    // is the only place it can be checked.
    check(sender, tally, "a catalog token id resolves to a block",
        Items.materialFor("iron_ingot") == Material.IRON_INGOT);
    check(sender, tally, "every material this economy trades resolves", true);
    for (String token : new String[] {"iron_ingot", "oak_log", "stone", "glass",
                                      "coal", "copper_ingot", "oak_planks", "redstone"}) {
      check(sender, tally, "  " + token + " is a real block", Items.materialFor(token) != null);
    }
    check(sender, tally, "an upper-case token id still resolves",
        Items.materialFor("IRON_INGOT") == Material.IRON_INGOT);
    check(sender, tally, "surrounding space is trimmed",
        Items.materialFor("  stone  ") == Material.STONE);
    // The branch /market relies on to warn that the chain trades something this
    // game cannot hold.
    check(sender, tally, "a token with no block resolves to null",
        Items.materialFor("unobtainium") == null);
    check(sender, tally, "an empty token id resolves to null", Items.materialFor("") == null);
    check(sender, tally, "a null token id resolves to null", Items.materialFor(null) == null);

    sender.sendMessage((tally[1] == 0 ? GREEN : RED) + "inventory selftest: "
        + tally[0] + " passed, " + tally[1] + " failed");
    return true;
  }

  private static void check(CommandSender sender, int[] tally, String what, boolean ok) {
    if (ok) { tally[0]++; return; }
    tally[1]++;
    sender.sendMessage(RED + "  FAIL  " + what);
  }

  // --------------------------------------------------------------- helpers

  /** The console is not a player, so it borrows a reserved id rather than a branch. */
  private static UUID idOf(CommandSender sender) {
    return sender instanceof Player ? ((Player) sender).getUniqueId() : Sessions.CONSOLE;
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
