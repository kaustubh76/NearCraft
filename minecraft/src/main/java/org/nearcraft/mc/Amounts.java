package org.nearcraft.mc;

/**
 * yoctoNEAR to something a player can read.
 *
 * <p>NEAR amounts are u128 integers of 10^-24 NEAR and arrive as decimal
 * strings. They must never go through a double on the way to a screen: a
 * double carries about 15 significant digits and these have up to 39, so
 * {@code Double.parseDouble} silently rounds a balance. Everything here is
 * string arithmetic for that reason.
 */
public final class Amounts {

  private static final int DECIMALS = 24;

  private Amounts() {}

  /**
   * Render a yoctoNEAR amount as NEAR, trimmed.
   *
   * <p>{@code "4000000000000000000000"} becomes {@code "0.004"}, and
   * {@code "0"} stays {@code "0"}. Anything that is not a non-negative integer
   * string comes back unchanged, because a display helper is the wrong place to
   * decide that a server lied.
   */
  public static String near(String yocto) {
    if (yocto == null) return "0";
    String digits = yocto.trim();
    boolean negative = digits.startsWith("-");
    if (negative) digits = digits.substring(1);
    if (digits.isEmpty()) return yocto;
    for (int i = 0; i < digits.length(); i++) {
      if (digits.charAt(i) < '0' || digits.charAt(i) > '9') return yocto;
    }
    while (digits.length() > 1 && digits.charAt(0) == '0') digits = digits.substring(1);
    if (digits.length() <= DECIMALS) digits = "0".repeat(DECIMALS - digits.length() + 1) + digits;

    String whole = digits.substring(0, digits.length() - DECIMALS);
    String fraction = digits.substring(digits.length() - DECIMALS);
    while (fraction.endsWith("0")) fraction = fraction.substring(0, fraction.length() - 1);
    String out = fraction.isEmpty() ? whole : whole + "." + fraction;
    return negative && !out.equals("0") ? "-" + out : out;
  }

  /**
   * NEAR to yoctoNEAR, the inverse of {@link #near}.
   *
   * <p>{@code "0.05"} becomes {@code "50000000000000000000000"}. String
   * arithmetic again, and for a sharper reason this time: {@link #near} only
   * renders a number for a human to read, while this one produces an argument
   * the contract will act on. A {@code double} round-trip would stake a
   * different amount from the one the player typed.
   *
   * <p>A fraction finer than a yoctoNEAR is <b>refused</b>, not rounded: the
   * caller asked to move an amount that does not exist, and silently moving a
   * different one is how a ledger stops matching what anybody agreed to.
   *
   * @return the yoctoNEAR amount, or null when the input is not a non-negative
   *     decimal number this chain can represent
   */
  public static String yocto(String near) {
    if (near == null) return null;
    String text = near.trim();
    if (text.isEmpty() || text.startsWith("-")) return null;

    int dot = text.indexOf('.');
    if (dot != text.lastIndexOf('.')) return null;
    String whole = dot < 0 ? text : text.substring(0, dot);
    String fraction = dot < 0 ? "" : text.substring(dot + 1);
    if (whole.isEmpty() && fraction.isEmpty()) return null;
    if (!digitsOnly(whole) || !digitsOnly(fraction)) return null;
    // More than 24 decimal places is finer than the chain's smallest unit.
    if (fraction.length() > DECIMALS) return null;

    String digits = (whole.isEmpty() ? "0" : whole) + fraction + "0".repeat(DECIMALS - fraction.length());
    while (digits.length() > 1 && digits.charAt(0) == '0') digits = digits.substring(1);
    return digits;
  }

  private static boolean digitsOnly(String text) {
    for (int i = 0; i < text.length(); i++) {
      if (text.charAt(i) < '0' || text.charAt(i) > '9') return false;
    }
    return true;
  }

  /** The same, with a unit, for a line of chat. */
  public static String nearWithUnit(String yocto) {
    return near(yocto) + " NEAR";
  }
}
