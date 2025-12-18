import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json
import asyncio
import os
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from langgraph.graph import StateGraph, END

# Try to import agent, otherwise use a mock
try:
    from agent import agent
except ImportError:
    print("Warning: 'agent.py' not found. Using a mock agent for testing.")
    
    # Mock Agent Setup
    from langgraph.graph import MessageGraph
    
    def mock_node(state):
        last_message = state[-1]
        return AIMessage(content=f"I received your message: {last_message.content}")

    workflow = MessageGraph()
    workflow.add_node("agent", mock_node)
    workflow.set_entry_point("agent")
    workflow.add_edge("agent", END)
    agent = workflow.compile()

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    messages: List[Dict[str, Any]]
    thread_id: Optional[str] = None

# Helper to serialize LangChain objects
def _serialize(obj):
    try:
        # Check for LangGraph Command object specifically
        if type(obj).__name__ == "Command":
            # Try to extract message content from the updates
            if hasattr(obj, "update") and isinstance(obj.update, dict):
                messages = obj.update.get("messages", [])
                if messages and isinstance(messages, list):
                    # Return the content of the last message if available
                    last_msg = messages[-1]
                    if hasattr(last_msg, "content"):
                        return last_msg.content
            # Fallback for Command
            return "Task Update processed."

        if hasattr(obj, "model_dump"):
            return obj.model_dump()
        if hasattr(obj, "dict"):
            return obj.dict()
        
        if isinstance(obj, list):
            return [_serialize(item) for item in obj]
        if isinstance(obj, dict):
            return {k: _serialize(v) for k, v in obj.items()}
            
        if not isinstance(obj, (str, int, float, bool, type(None))):
            return str(obj)
        return obj
    except Exception:
        return str(obj)

@app.get("/api/files")
async def list_files():
    """List all files in the agent_memories directory."""
    mem_dir = "./agent_memories"
    if not os.path.exists(mem_dir):
        return {"files": []}
    
    files = []
    for f in os.listdir(mem_dir):
        if os.path.isfile(os.path.join(mem_dir, f)):
            files.append(f)
    return {"files": files}

@app.get("/api/files/{filename}")
async def get_file_content(filename: str):
    """Get content of a specific file."""
    mem_dir = "./agent_memories"
    filepath = os.path.join(mem_dir, filename)
    
    # Security check: ensure parsing path doesn't go outside
    if not os.path.abspath(filepath).startswith(os.path.abspath(mem_dir)):
        raise HTTPException(status_code=403, detail="Access denied")
        
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        return {"filename": filename, "content": content}
    except Exception as e:
         return {"filename": filename, "content": f"Error reading file: {str(e)}"}

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Stream chat responses from the agent.
    Returns a stream of JSON lines.
    """
    
    # Convert input messages to LangChain format explicitly
    converted_messages = []
    for m in request.messages:
        role = m.get("role")
        content = m.get("content", "")
        if role in ["user", "human"]:
            converted_messages.append(HumanMessage(content=content))
        elif role in ["assistant", "ai"]:
            converted_messages.append(AIMessage(content=content))
        elif role == "tool":
            # Tool messages need a tool_call_id, defaulting if missing (though strictly required)
            converted_messages.append(ToolMessage(content=content, tool_call_id=m.get("tool_call_id", "unknown")))
    
    inputs = {"messages": converted_messages}
    
    # distinct thread_id for persistence if provided
    config = {"configurable": {"thread_id": request.thread_id or "default_thread"}}

    async def event_generator():
        # stream_mode="events" or ["messages", "values"]
        # We use ["messages", "values"] to get token-by-token and state updates
        
        try:
            # We use astream_events to get granular token updates
            # v1 is the standard legacy version, v2 is newer but sometimes has breaking changes. v1 is safe.
            async for event in agent.astream_events(inputs, config=config, version="v1"):
                kind = event["event"]
                data = event["data"]

                # Stream partial tokens for the final response
                if kind == "on_chat_model_stream":
                    chunk = data.get("chunk")
                    # chunk is an AIMessageChunk, we need its content
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        if content:
                            # print(f"DEBUG: Token: {content[0:5]}...") # Too verbose to print every token
                            yield json.dumps({
                                "type": "token",
                                "content": content
                            }) + "\n"
                
                # Stream tool start events (to show "Calling tool..." in UI)
                elif kind == "on_tool_start":
                    print(f"DEBUG: Tool Start: {event['name']}")
                    yield json.dumps({
                        "type": "tool_start",
                        "tool": event["name"],
                        "run_id": event["run_id"],
                        "input": _serialize(data.get("input"))
                    }) + "\n"

                # Stream tool end events
                elif kind == "on_tool_end":
                    print(f"DEBUG: Tool End: {event['name']}")
                    output = data.get("output")
                    yield json.dumps({
                        "type": "tool_end",
                        "tool": event["name"],
                        "run_id": event["run_id"],
                        "output": _serialize(output)
                    }) + "\n"
                
                # Capture state updates (like todos)
                elif kind == "on_chain_end":
                    # Check if this update contains 'todos'
                    output = data.get("output")
                    if output and isinstance(output, dict) and "todos" in output:
                        print("DEBUG: Updating Todos")
                        yield json.dumps({
                            "type": "values",
                            "todos": _serialize(output["todos"])
                        }) + "\n"
                    
        except Exception as e:
            print(f"Server Error: {e}")
            import traceback
            traceback.print_exc()
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"
            
        # Send a final done message
        print("DEBUG: Stream Done")
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
