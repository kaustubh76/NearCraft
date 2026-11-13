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

  /** The same, with a unit, for a line of chat. */
  public static String nearWithUnit(String yocto) {
    return near(yocto) + " NEAR";
  }
}
