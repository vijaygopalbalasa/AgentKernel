// Agent template registry — maps template names to generators

import { getChatTemplate } from "./chat.js";
import { getWorkerTemplate } from "./worker.js";
import { getMonitorTemplate } from "./monitor.js";
import { getServiceTemplate } from "./service.js";

export interface TemplateOutput {
  indexTs: string;
  manifestJson: string;
  testTs: string;
}

export type TemplateName = "chat" | "worker" | "monitor" | "service";

const templateRegistry: Record<TemplateName, (slug: string, name: string) => TemplateOutput> = {
  chat: getChatTemplate,
  worker: getWorkerTemplate,
  monitor: getMonitorTemplate,
  service: getServiceTemplate,
};

export const TEMPLATE_NAMES: TemplateName[] = ["chat", "worker", "monitor", "service"];

export function getTemplate(template: TemplateName, slug: string, name: string): TemplateOutput {
  const generator = templateRegistry[template];
  if (!generator) {
    throw new Error(`Unknown template: ${template}. Available: ${TEMPLATE_NAMES.join(", ")}`);
  }
  return generator(slug, name);
}
