// Timeouts (milliseconds)
export const LOCATOR_ACTION_TIMEOUT = 2000;
export const CACHED_ACTION_TIMEOUT = 5000;
export const STOP_DELAY = 3000;
export const SNAPSHOT_TIMEOUT = 5000;
export const DOM_STABILIZATION_IDLE = 500;
export const DOM_STABILIZATION_TIMEOUT = 5000;
export const INITIAL_DOM_STABILIZATION_IDLE = 3000;
export const ASSERTION_MODEL_TIMEOUT = 35000;
export const STEP_EXECUTION_TIMEOUT = 180000;
export const WAIT_CONDITION_TIMEOUT = 120000;
export const VISUAL_DIFF_EXPLANATION_TIMEOUT = 45000;
export const WAIT_CONDITION_INITIAL_INTERVAL = 1000;
export const WAIT_CONDITION_MAX_INTERVAL = 10000;
export const EMAIL_INITIAL_WAIT = 5000;
export const EMAIL_RETRY_DELAY = 60000;

// Limits
export const STEP_EXECUTION_MAX_STEPS = 25;
export const USER_FLOW_MAX_STEPS = 50;
export const MAX_RETRIES = 3;

// Thinking budgets (tokens)
export const THINKING_BUDGET_DEFAULT = 1024;

// Redis
export const GLOBAL_VALUES_TTL_SECONDS = 86400;

// Video assertions
export const VIDEO_DEFAULT_DIR = "/tmp/passmark-recordings";
export const VIDEO_DEFAULT_WIDTH = 1280;
export const VIDEO_DEFAULT_HEIGHT = 720;
export const VIDEO_FILE_POLL_INTERVAL = 1500;
export const VIDEO_FILE_POLL_TIMEOUT = 120000;
export const VIDEO_ASSERTION_MODEL = "gemini-3-flash-preview";
