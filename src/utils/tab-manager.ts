import type { Page } from "@playwright/test";

export type TabTarget = "main" | "latest" | number;

export type TabManager = {
  active: () => Page;
  pages: () => Page[];
  switchTo: (target: TabTarget) => Promise<Page>;
};

export const createTabManager = (initialPage: Page): TabManager => {
  const pages: Page[] = [initialPage];
  let activeIndex = 0;

  const context = initialPage.context();

  context.on("page", (newPage) => {
    if (!pages.includes(newPage)) {
      pages.push(newPage);
    }
    // Auto-switch active focus to any newly opened tab so subsequent
    // snapshots/actions target it without explicit switching.
    activeIndex = pages.indexOf(newPage);

    newPage.on("close", () => {
      const idx = pages.indexOf(newPage);
      if (idx === -1) return;
      pages.splice(idx, 1);
      if (activeIndex === idx) {
        activeIndex = Math.max(0, pages.length - 1);
      } else if (activeIndex > idx) {
        activeIndex -= 1;
      }
    });
  });

  return {
    active: () => pages[activeIndex],
    pages: () => [...pages],
    switchTo: async (target) => {
      let idx: number;
      if (target === "main") idx = 0;
      else if (target === "latest") idx = pages.length - 1;
      else idx = target;
      if (idx < 0 || idx >= pages.length) {
        throw new Error(`switchToTab: invalid target ${target}; ${pages.length} tab(s) open.`);
      }
      activeIndex = idx;
      return pages[idx];
    },
  };
};
