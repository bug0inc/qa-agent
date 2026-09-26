import { ConfigurationError, AIModelError } from "./errors";
import { getConfig } from "./config";
import { EMAIL_INITIAL_WAIT, EMAIL_RETRY_DELAY, MAX_RETRIES } from "./constants";
import { logger } from "./logger";

function getEmailProvider() {
  const provider = getConfig().email;
  if (!provider) {
    throw new ConfigurationError(
      "Email provider not configured. Call configure({ email: ... }) before using email features.",
    );
  }
  return provider;
}

/**
 * Generates a unique test email address using the configured email provider's domain.
 *
 * @param options - Optional email generation parameters
 * @param options.prefix - Email prefix before the timestamp. Default: "test.user"
 * @param options.timestamp - Timestamp for uniqueness. Default: Date.now()
 * @returns Email address in the format `prefix.timestamp@domain`
 * @throws If no email provider is configured via `configure()`
 *
 * @example
 * ```typescript
 * const email = generateEmail(); // "test.user.1711234567890@emailsink.dev"
 * const custom = generateEmail({ prefix: "signup" }); // "signup.1711234567890@emailsink.dev"
 * ```
 */
export const generateEmail = ({
  prefix = "test.user",
  timestamp = Date.now(),
}: {
  prefix?: string;
  timestamp?: number;
} = {}) => {
  const { domain } = getEmailProvider();
  return `${prefix}.${timestamp}@${domain}`;
};

/**
 * Extracts content from an email using the configured email provider.
 * Waits for the email to arrive, then polls the provider with retries.
 *
 * @param options - Extraction configuration
 * @param options.email - The email address to extract content from
 * @param options.prompt - Natural language prompt describing what to extract (e.g. "get the 6 digit verification code")
 * @param options.maxRetries - Maximum number of extraction attempts. Default: 3
 * @param options.retryDelayMs - Delay between retries in milliseconds. Default: 60000 (1 minute)
 * @returns The extracted content as a string
 * @throws If no email provider is configured via `configure()`
 * @throws If content cannot be extracted after all retry attempts
 *
 * @example
 * ```typescript
 * const otp = await extractEmailContent({
 *   email: "test.user.123@emailsink.dev",
 *   prompt: "get the 6 digit verification code",
 * });
 * ```
 */
export async function extractEmailContent({
  email,
  prompt,
  maxRetries = MAX_RETRIES,
  retryDelayMs = EMAIL_RETRY_DELAY,
}: {
  email: string;
  prompt: string;
  maxRetries?: number;
  retryDelayMs?: number;
}): Promise<string> {
  const provider = getEmailProvider();

  // Add an initial delay before the first attempt to allow email to arrive
  logger.info(`Initial wait before extracting email content for ${email}...`);
  await new Promise((resolve) => setTimeout(resolve, EMAIL_INITIAL_WAIT));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.debug(`Waiting for email content (attempt ${attempt}/${maxRetries})...`);

    try {
      const result = await provider.extractContent({ email, prompt });
      logger.info(`Successfully extracted email content: ${result}`);
      return result;
    } catch (error) {
      logger.warn(`Error fetching email content (attempt ${attempt}): ${error}`);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new AIModelError(
    `Failed to extract email content after ${maxRetries} attempts. Email: ${email}, Prompt: ${prompt}`,
  );
}
