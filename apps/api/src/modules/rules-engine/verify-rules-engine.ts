import { RulesEngineService } from "./rules-engine.service";
import {
  exampleEmails,
  expectedClassifications,
} from "./rules-engine.examples";

/**
 * Verification script for the rules engine.
 * Run with: npx tsx verify-rules-engine.ts
 */
function verifyRulesEngine(): void {
  const service = new RulesEngineService();

  console.log("Rules Engine Verification");
  console.log("=".repeat(70));

  let passed = 0;
  let failed = 0;

  for (const { name, input } of exampleEmails) {
    const result = service.classify(input);
    const expected = expectedClassifications[name];
    const categoryMatch = expected?.ruleCategory === result.ruleCategory;
    const confidenceMatch = expected?.ruleConfidence === result.ruleConfidence;
    const status = categoryMatch && confidenceMatch ? "✓" : "✗";

    if (categoryMatch && confidenceMatch) {
      passed++;
    } else {
      failed++;
    }

    console.log(`\n${status} ${name}`);
    console.log(
      `  Category: ${result.ruleCategory} (expected: ${expected?.ruleCategory})`,
    );
    console.log(
      `  Confidence: ${result.ruleConfidence} (expected: ${expected?.ruleConfidence})`,
    );
    console.log(`  Matched Rules: ${result.matchedRules.join(", ") || "none"}`);
    console.log(`  Reasons:`);
    for (const reason of result.ruleReasons) {
      console.log(`    - ${reason}`);
    }

    if (!categoryMatch) {
      console.log(`  ⚠ Category mismatch!`);
    }
    if (!confidenceMatch) {
      console.log(`  ⚠ Confidence mismatch!`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    `Results: ${passed} passed, ${failed} failed out of ${passed + failed}`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

verifyRulesEngine();
