import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  padding?: "default" | "roomy";
  "data-role": "user" | "assistant";
};

const BASE_CLASSES = "session-stack-surface text-xl leading-[1.7] text-text-primary";

const PADDING_CLASSES = {
  default: "px-4 py-3",
  roomy: "px-5 py-4",
} as const;

export function MessageBubble({ children, padding = "default", "data-role": dataRole }: Props) {
  return (
    <div data-message-bubble="true" data-role={dataRole} className={`${BASE_CLASSES} ${PADDING_CLASSES[padding]}`}>
      {children}
    </div>
  );
}
