import { RunStepsOptions, Step, UserFlowOptions } from "../types";

/**
 * Build the instruction for a single step in CUA mode.
 *
 * Contract differs from the snapshot prompt: the model sees screenshots (not
 * ARIA trees), has a single built-in `computer` tool, and issues coordinate-based
 * actions. Keep the instruction concise — OpenAI's CUA model does its own visual
 * reasoning, so we don't need to enumerate tools.
 */
export const buildRunStepsPromptCUA = ({
  auth,
  userFlow,
  step,
  steps,
  stepIndex,
}: Pick<RunStepsOptions, "auth" | "userFlow" | "steps"> & {
  step: Step;
  stepIndex: number;
}): string => {
  return `
You are an expert QA agent testing a web application using computer-use capabilities. You see the browser as screenshots and act by clicking, typing, scrolling, etc.

<UserFlow>
${userFlow}
</UserFlow>

Execute **ONLY** the following step and stop immediately after it is done:

<CurrentStep>
${step.description}
</CurrentStep>

<StepIndex>
Current Step Index: ${stepIndex + 1} out of ${steps.length} steps.
</StepIndex>

${
  stepIndex + 1 < steps.length
    ? `<NextStep>
(For context only — DO NOT execute.) Next step: "${steps[stepIndex + 1].description}"
</NextStep>`
    : ""
}

${
  step.data
    ? `<Data>
Use this data for the current step: ${JSON.stringify(step.data)}
</Data>`
    : ""
}

${
  auth
    ? `<Auth>
If a login screen appears, use:
- Email: ${auth.email}
- Password: ${auth.password}${auth.callbackUrl ? `\n- Go to this callbackUrl post login: ${auth.callbackUrl}` : ""}
</Auth>`
    : ""
}

<Instructions>
- Look at the current screenshot before acting. If the page is still loading, use the wait action.
- Perform only the current step. Stop as soon as the expected result is visible in the screenshot.
- If the step fails or produces a validation error, correct the input and retry.
- Do not navigate to a new URL unless the step description explicitly says to.
- Keep individual action batches small so the screenshot loop can verify progress.
- If you see any unexpected pop-ups or modals, try to close them before proceeding.
- After you execute the step, analyze the returned screenshot. The step execution is considered successful only if the latest screenshot reflects the expected state after performing the step. If it doesn't, you must take a fresh screenshot and retry executing the step until the expected state is achieved.
</Instructions>
`.trim();
};

/**
 * Build the instruction for a full user flow in CUA mode.
 */
export const buildRunUserFlowPromptCUA = ({
  userFlow,
  steps,
  assertion,
}: Pick<UserFlowOptions, "userFlow" | "assertion" | "steps">): string => {
  return `
You are an expert QA agent testing a web application using computer-use capabilities. You see the browser as screenshots and act by clicking, typing, scrolling, etc.

<UserFlow>
${userFlow}
</UserFlow>

${
  steps
    ? `<Steps>
Follow these steps in order:
${steps}
Stop once all steps are complete.
</Steps>`
    : ""
}

${
  assertion
    ? `<Assertion>
${assertion}
</Assertion>

When the flow is complete, evaluate the assertion and report:
- assertionPassed: boolean
- confidenceScore: 0-100
- reasoning: short explanation`
    : ""
}

<Instructions>
- Inspect each screenshot before acting.
- Recover from transient errors (validation messages, slow loads) by retrying once.
- Stop as soon as the flow is complete — do not continue exploring the app.
</Instructions>
`.trim();
};
