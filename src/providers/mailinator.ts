import type { EmailProvider } from "../config";

type MailinatorInbox = {
  msgs?: Array<{
    id: string;
  }>;
};

type MailinatorMessage = {
  parts?: Array<{
    body?: string;
  }>;
};

/**
 * Mailinator provider for retrieving email content from Mailinator inboxes.
 *
 * @param options - Configuration options for the Mailinator provider
 * @returns An EmailProvider instance
 */
export function mailinatorProvider(options: {
  apiKey?: string;
} = {}): EmailProvider {
  return {
    domain: "mailinator.com",

    extractContent: async ({ email }) => {
      const headers: Record<string, string> = {};

      if (options.apiKey) {
        headers.Authorization = `Bearer ${options.apiKey}`;
      }

      const [username] = email.split("@");

      if (!username) {
        throw new Error(`[mailinator] Invalid email: ${email}`);
      }

      const inboxResponse = await fetch(
        `https://mailinator.com/api/v2/domains/mailinator.com/inboxes/${username}`,
        {
          headers,
        }
      );

      if (!inboxResponse.ok) {
        throw new Error(
          `[mailinator] Failed to fetch inbox for ${email}: HTTP ${inboxResponse.status}`
        );
      }

      const inbox = (await inboxResponse.json()) as MailinatorInbox;

      if (!inbox.msgs || inbox.msgs.length === 0) {
        throw new Error(
          `[mailinator] No emails found for ${email}`
        );
      }

      const latestEmail = inbox.msgs[0];
      const messageResponse = await fetch(
        `https://mailinator.com/api/v2/domains/mailinator.com/inboxes/${username}/messages/${latestEmail.id}`,
        {
          headers,
        }
      );

      if (!messageResponse.ok) {
        throw new Error(
          `[mailinator] Failed to fetch message ${latestEmail.id}: HTTP ${messageResponse.status}`
        );
      }

      const message = (await messageResponse.json()) as MailinatorMessage;
      const emailBody = message.parts?.[0]?.body ?? "";

      if (!emailBody) {
        throw new Error(
          `[mailinator] Email body is empty for ${email}`
        );
      }

      return emailBody;
    },
  };
}