import { Message } from "@langchain/langgraph-sdk";
import { TodoItem } from "@/app/types/types";

// Define simpler internal types for compatibility if SDK types are strict
interface SimpleToolCall {
    name: string;
    args: any;
    id: string;
    type?: "tool_call";
}

export interface StreamUpdate {
    messages: Message[];
    todos?: TodoItem[];
    isLoading: boolean;
    toolCall?: string;
}

export async function parseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onUpdate: (update: Partial<StreamUpdate>) => void,
    initialMessages: Message[]
) {
    const decoder = new TextDecoder();
    let buffer = "";

    // We maintain a local mutable copy of messages to apply updates incrementally
    let currentMessages: Message[] = [...initialMessages];

    // State to track the current streaming AI message
    let currentAIIndex = -1;
    const ensureAIMessage = () => {
        // If the last message is not an AI message (or if we haven't started one), create one
        const lastMsg = currentMessages[currentMessages.length - 1];
        if (!lastMsg || lastMsg.type !== "ai") {
            const newMsg: Message = {
                type: "ai",
                id: "streaming-ai-" + Date.now(),
                content: "",
                tool_calls: [],
                additional_kwargs: {} as any,
                response_metadata: {} as any
            };
            currentMessages.push(newMsg);
            currentAIIndex = currentMessages.length - 1;
        } else {
            currentAIIndex = currentMessages.length - 1;
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            let shouldEmit = false;

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const event = JSON.parse(line);

                    switch (event.type) {
                        case "token":
                            ensureAIMessage();
                            // Append content to current AI message
                            const aiMsg = currentMessages[currentAIIndex];
                            // Handle content being string or array (though usually string for streaming)
                            if (typeof aiMsg.content === "string") {
                                aiMsg.content += event.content;
                            } else {
                                // If it was somehow initialized as array, we might want to normalize or handle it. 
                                // For now, assume string for simplicity in this stream parser
                                aiMsg.content = (aiMsg.content || "") + event.content;
                            }
                            shouldEmit = true;
                            break;

                        case "tool_start":
                            ensureAIMessage();
                            const parentAIMsg = currentMessages[currentAIIndex];
                            if (!parentAIMsg.tool_calls) parentAIMsg.tool_calls = [];

                            // Check if we already have this tool call (unlikely in this stream format, but good safety)
                            // We use run_id from server as the tool call id
                            const toolId = event.run_id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                            const newToolCall: SimpleToolCall = {
                                name: event.tool,
                                args: event.input || {},
                                id: toolId
                            };

                            parentAIMsg.tool_calls.push(newToolCall as any);
                            onUpdate({ toolCall: event.tool });
                            shouldEmit = true;
                            break;

                        case "tool_end":
                            // When tool ends, we append a new ToolMessage
                            // We need the same ID used in tool_start
                            const endToolId = event.run_id;

                            // Note: The UI expects a ToolMessage to follow the AIMessage
                            const toolOutputMsg: Message = {
                                type: "tool",
                                id: "tool-res-" + (endToolId || Date.now()),
                                tool_call_id: endToolId || "unknown",
                                name: event.tool,
                                content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2),
                                additional_kwargs: {} as any,
                                response_metadata: {} as any
                            };

                            currentMessages.push(toolOutputMsg);
                            // reset currentAIIndex because the next token might be a NEW AI message (or continue the old one? usually patterns are: AI -> Tool -> AI)
                            // If the pattern is AI (calls tool) -> Tool -> AI (interprets), we probably want a new AI message for the interpretation.
                            // So we invalidate currentAIIndex
                            currentAIIndex = -1;
                            onUpdate({ toolCall: undefined });
                            shouldEmit = true;
                            break;

                        case "values":
                            if (event.todos) {
                                onUpdate({ todos: event.todos });
                            }
                            break;

                        case "error":
                            console.error("Stream error:", event.content);
                            break;

                        case "done":
                            return;
                    }
                } catch (e) {
                    console.error("Error parsing JSON line:", line, e);
                }
            }

            if (shouldEmit) {
                onUpdate({ messages: [...currentMessages] });
            }
        }
    } catch (error) {
        console.error("Stream reading error:", error);
    } finally {
        reader.releaseLock();
    }
}
