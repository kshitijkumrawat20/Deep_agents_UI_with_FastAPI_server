"use client";

import { useCallback, useState } from "react";
import {
  type Message,
  type Assistant,
  type Checkpoint,
} from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import type { TodoItem } from "@/app/types/types";
import { useQueryState } from "nuqs";
import { parseStream } from "@/app/utils/streamParser";

export type StateType = {
  messages: Message[];
  todos: TodoItem[];
  files: Record<string, string>;
  email?: {
    id?: string;
    subject?: string;
    page_content?: string;
  };
  ui?: any;
};

export function useChat({
  activeAssistant,
  onHistoryRevalidate,
  thread,
}: {
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  thread?: UseStreamThread<StateType>;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const [messages, setMessages] = useState<Message[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [toolCall, setToolCall] = useState<string | undefined>(undefined);

  const sendMessage = useCallback(
    async (content: string) => {
      const newMessage: Message = { id: uuidv4(), type: "human", content };
      const updatedMessages = [...messages, newMessage];
      setMessages(updatedMessages);
      setIsLoading(true);

      try {
        // Use direct URL to bypass Next.js proxy timeout
        const response = await fetch("http://127.0.0.1:8000/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updatedMessages.map((m) => ({
              role: m.type,
              content: m.content,
            })),
            thread_id: threadId ?? undefined,
          }),
        });

        if (!response.body) throw new Error("No response body");
        const reader = response.body.getReader();

        await parseStream(
          reader,
          (update) => {
            if (update.messages) setMessages(update.messages);
            if (update.todos) setTodos(update.todos);
            if (update.toolCall !== undefined) setToolCall(update.toolCall);
          },
          updatedMessages
        );
      } catch (e) {
        console.error("Chat error:", e);
      } finally {
        setIsLoading(false);
        setToolCall(undefined);
        onHistoryRevalidate?.(); // Refresh history
      }
    },
    [messages, threadId, onHistoryRevalidate]
  );

  // Fallback / Stubbed functions to maintain compatibility with UI components
  // that might expect these from the original hook
  const stream = {
    messages,
    values: { todos, files: {}, email: undefined, ui: undefined },
    isLoading,
    isThreadLoading: false,
    interrupt: undefined,
    getMessagesMetadata: () => ({}),
    submit: () => { }, // No-op, managed by sendMessage
    stop: () => { },
  };

  return {
    stream,
    todos,
    files: {}, // TODO: Implement file syncing if needed
    email: undefined,
    ui: undefined,
    setFiles: async () => { }, // TODO
    messages,
    isLoading,
    isThreadLoading: false, // Not using SDK threading for now
    interrupt: undefined,
    getMessagesMetadata: () => ({}),
    sendMessage,
    runSingleStep: () => { }, // Simplified for now
    continueStream: () => { },
    stopStream: () => { },
    markCurrentThreadAsResolved: () => { },
    resumeInterrupt: () => { },
    toolCall, // Expose this if UI wants to show "Calling tool X..."
  };
}
