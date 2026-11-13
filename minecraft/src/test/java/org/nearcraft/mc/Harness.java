package org.nearcraft.mc;

import java.util.ArrayList;
import java.util.List;

/**
 * A test runner in forty lines, because the alternative was a dependency.
 *
 * <p>This repository has one runtime dependency and keeps it; adding JUnit to
 * run nine assertions would be the larger change. Exits non-zero on the first
 * failure count above zero, which is all a build script needs to know.
 *
 * <p>Every check here was made to fail once before it was believed — the house
 * rule in AGENTS.md, earned by a key audit that passed for weeks while auditing
 * nothing.
 */
public final class Harness {

  private final List<String> failures = new ArrayList<>();
  private int passed = 0;
  private final String suite;

  public Harness(String suite) { this.suite = suite; }

  public void check(String what, boolean condition) {
    if (condition) { passed++; return; }
    failures.add(what);
    System.out.println("  FAIL  " + what);
  }

  public void equals(String what, Object expected, Object actual) {
    boolean same = expected == null ? actual == null : expected.equals(actual);
    if (!same) {
      failures.add(what);
      System.out.println("  FAIL  " + what);
      System.out.println("        expected: " + expected);
      System.out.println("        actual:   " + actual);
      return;
    }
    passed++;
  }

  /** Assert that a run throws, and that the message says why. */
  public void refuses(String what, String expectedFragment, Runnable work) {
    try {
      work.run();
      failures.add(what);
      System.out.println("  FAIL  " + what + " — it was accepted, and should not have been");
    } catch (RuntimeException e) {
      String message = e.getMessage() == null ? "" : e.getMessage();
      if (expectedFragment != null && !message.contains(expectedFragment)) {
        failures.add(what);
        System.out.println("  FAIL  " + what + " — refused, but for the wrong reason: " + message);
        return;
      }
      passed++;
    }
  }

  public int report() {
    System.out.println(suite + ": " + passed + " passed, " + failures.size() + " failed");
    return failures.isEmpty() ? 0 : 1;
  }

  public static void main(String[] args) throws Exception {
    int status = 0;
    status |= JsonTest.run();
    status |= PlayClientTest.run();
    if (status != 0) {
      System.out.println("\nFAILED");
      System.exit(1);
    }
    System.out.println("\nall Java checks passed");
  }
}
