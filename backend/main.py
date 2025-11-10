from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
import httpx
from typing import Optional
from dotenv import load_dotenv

# load environment from .env if present
load_dotenv()

# App and CORS configuration
app = FastAPI()

# Build allowed origins from environment or default to localhost dev origins
_allowed = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
if _allowed.strip() == "*":
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in _allowed.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db:5432/postgres")
engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Conversation and Message models
class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), default="Conversation")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role = Column(String(32), nullable=False)
    content = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# Create tables
Base.metadata.create_all(bind=engine)


# Request / response models
class MessageSchema(BaseModel):
    message: str


class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None


class ConversationCreate(BaseModel):
    title: Optional[str] = None

@app.post("/message")
async def create_message(message: MessageSchema):
    db = SessionLocal()
    try:
        # create a conversation-less message (legacy)
        db_message = Message(role='user', content=message.message, conversation_id=None)
        db.add(db_message)
        db.commit()
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()

@app.get("/messages")
async def get_messages():
    db = SessionLocal()
    try:
        messages = db.query(Message).order_by(Message.id.desc()).all()
        return [{"id": msg.id, "role": msg.role, "content": msg.content, "conversation_id": msg.conversation_id} for msg in messages]
    except Exception as e:
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()


@app.post("/conversations")
async def create_conversation(payload: ConversationCreate):
    db = SessionLocal()
    try:
        title = payload.title or f"Conversation"
        conv = Conversation(title=title)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        return {"id": conv.id, "title": conv.title}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.get("/conversations")
async def list_conversations():
    db = SessionLocal()
    try:
        convs = db.query(Conversation).order_by(Conversation.created_at.desc()).all()
        out = []
        for c in convs:
            count = db.query(Message).filter(Message.conversation_id == c.id).count()
            last = db.query(Message).filter(Message.conversation_id == c.id).order_by(Message.id.desc()).first()
            preview = last.content[:200] if last and last.content else ""
            out.append({"id": c.id, "title": c.title, "message_count": count, "preview": preview})
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.get("/conversations/{conv_id}")
async def get_conversation(conv_id: int):
    db = SessionLocal()
    try:
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
        msgs = db.query(Message).filter(Message.conversation_id == conv_id).order_by(Message.id.asc()).all()
        return {"id": conv.id, "title": conv.title, "messages": [{"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()} for m in msgs]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/chat")
async def chat(req: ChatRequest):
    """Proxy a user message to OpenAI Chat Completions and return assistant reply.

    Expects environment variable OPENAI_API_KEY to be set. Optionally OPENAI_MODEL.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set in environment")

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    # Build payload for Chat Completions
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": req.message},
        ],
        "max_tokens": 800,
        "temperature": 0.2,
    }

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        db = SessionLocal()
        try:
            # If conversation id not provided, create one
            conv_id = req.conversation_id
            if conv_id is None:
                conv = Conversation(title="Conversation")
                db.add(conv)
                db.commit()
                db.refresh(conv)
                conv_id = conv.id

            # Save user message
            user_msg = Message(conversation_id=conv_id, role='user', content=req.message)
            db.add(user_msg)
            db.commit()

            r = await client.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            # Safely extract assistant content
            assistant_text = ""
            if "choices" in data and len(data["choices"]) > 0:
                choice = data["choices"][0]
                if "message" in choice and "content" in choice["message"]:
                    assistant_text = choice["message"]["content"]
                elif "text" in choice:
                    assistant_text = choice["text"]

            # Save assistant reply to DB
            assistant_msg = Message(conversation_id=conv_id, role='assistant', content=assistant_text)
            db.add(assistant_msg)
            db.commit()

            return {"reply": assistant_text, "conversation_id": conv_id}
        except httpx.HTTPStatusError as e:
            db.rollback()
            raise HTTPException(status_code=502, detail=f"Upstream error: {str(e)}")
        except Exception as e:
            db.rollback()
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            try:
                db.close()
            except Exception:
                pass