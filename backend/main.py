import os
import time
import logging
from typing import Optional, List
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime, BigInteger, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.exc import OperationalError
import httpx
from dotenv import load_dotenv

# ============================================================================
# LOGGING CONFIGURATION
# ============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# ENVIRONMENT CONFIGURATION
# ============================================================================
load_dotenv()

# ============================================================================
# DATABASE CONFIGURATION
# ============================================================================
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db:5432/postgres")
engine = create_engine(DATABASE_URL, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ============================================================================
# DATABASE MODELS
# ============================================================================
class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(BigInteger, primary_key=True, index=True)
    title = Column(String(255), default="Conversation")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(BigInteger, ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role = Column(String(32), nullable=False)
    content = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ============================================================================
# DATABASE INITIALIZATION WITH RETRY LOGIC
# ============================================================================
def init_db(max_retries: int = 5, retry_interval: int = 5):
    logger.info("Starting database initialization...")
    
    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"Database connection attempt {attempt}/{max_retries}")
            
            with engine.connect() as conn:
                conn.execute(func.now())
            
            logger.warning("Dropping all existing tables...")
            Base.metadata.drop_all(bind=engine)
            
            logger.info("Creating all tables...")
            Base.metadata.create_all(bind=engine)
            
            logger.info("✅ Database initialized successfully!")
            return
            
        except OperationalError as e:
            if attempt < max_retries:
                logger.warning(
                    f"⚠️  Database not ready: {str(e)}\n"
                    f"   Retrying in {retry_interval}s... ({attempt}/{max_retries})"
                )
                time.sleep(retry_interval)
            else:
                logger.error(f"❌ Failed to connect to database after {max_retries} attempts")
                raise HTTPException(
                    status_code=503,
                    detail="Database connection failed after maximum retries"
                )
        except Exception as e:
            logger.error(f"❌ Unexpected error during database initialization: {str(e)}")
            raise


# ============================================================================
# DATABASE DEPENDENCY
# ============================================================================
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ============================================================================
# HELPER: Generate conversation title from context
# ============================================================================
async def generate_conversation_title(messages_context: str, api_key: str) -> str:
    """
    Generate a concise, contextual title for the conversation based on the message context.
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            payload = {
                "model": "gpt-3.5-turbo",
                "messages": [
                    {
                        "role": "system",
                        "content": "Gere um título curto e descritivo (máximo 6 palavras) para uma conversa baseada no contexto fornecido. Responda APENAS com o título, sem aspas ou pontuação extra."
                    },
                    {
                        "role": "user",
                        "content": f"Contexto da conversa: {messages_context[:400]}"
                    }
                ],
                "max_tokens": 20,
                "temperature": 0.7,
            }
            
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json=payload,
                headers=headers
            )
            
            if r.status_code == 200:
                data = r.json()
                if "choices" in data and len(data["choices"]) > 0:
                    title = data["choices"][0]["message"]["content"].strip()
                    # Remove quotes if present
                    title = title.strip('"\'')
                    # Limit length
                    if len(title) > 60:
                        title = title[:57] + "..."
                    return title
    except Exception as e:
        logger.warning(f"Failed to generate title: {str(e)}")
    
    # Fallback: use first words of the context
    words = messages_context.split()[:6]
    return " ".join(words) + ("..." if len(messages_context.split()) > 6 else "")


async def update_conversation_title(conv_id: int, db: Session, api_key: str):
    """
    Update conversation title based on the conversation context.
    Triggered after 3+ messages to ensure enough context.
    """
    try:
        # Get message count
        msg_count = db.query(Message).filter(Message.conversation_id == conv_id).count()
        
        # Only update if we have at least 3 messages (user + assistant + user)
        if msg_count < 3:
            return
        
        # Get recent messages for context
        recent_messages = db.query(Message)\
            .filter(Message.conversation_id == conv_id)\
            .order_by(Message.id.asc())\
            .limit(6)\
            .all()
        
        # Build context string
        context_parts = []
        for msg in recent_messages:
            prefix = "Usuário" if msg.role == "user" else "Assistente"
            context_parts.append(f"{prefix}: {msg.content[:150]}")
        
        context = " | ".join(context_parts)
        
        # Generate new title
        new_title = await generate_conversation_title(context, api_key)
        
        # Update conversation
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        if conv and conv.title != new_title:
            conv.title = new_title
            db.commit()
            logger.info(f"Updated conversation {conv_id} title to: {new_title}")
            
    except Exception as e:
        logger.warning(f"Failed to update conversation title: {str(e)}")


# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================
class MessageSchema(BaseModel):
    message: str


class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None


class ConversationCreate(BaseModel):
    title: Optional[str] = None


class MessageResponse(BaseModel):
    id: int
    role: str
    content: str
    conversation_id: Optional[int]


class ConversationResponse(BaseModel):
    id: int
    title: str
    message_count: int
    preview: str


class ConversationDetailResponse(BaseModel):
    id: int
    title: str
    messages: List[dict]


class ChatResponse(BaseModel):
    reply: str
    conversation_id: int
    title: Optional[str] = None


# ============================================================================
# FASTAPI APP INITIALIZATION
# ============================================================================
app = FastAPI(
    title="MyAgent API",
    description="AI Chat Agent with conversation management",
    version="1.0.0"
)

# ============================================================================
# CORS CONFIGURATION
# ============================================================================
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

# ============================================================================
# STARTUP EVENT
# ============================================================================
@app.on_event("startup")
async def startup_event():
    logger.info("🚀 Starting MyAgent API...")
    init_db()
    logger.info("✅ Application ready!")


# ============================================================================
# HEALTH CHECK ENDPOINT
# ============================================================================
@app.get("/health")
async def health():
    try:
        with engine.connect() as conn:
            conn.execute(func.now())
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Service unhealthy")


# ============================================================================
# MESSAGE ENDPOINTS
# ============================================================================
@app.post("/message")
async def create_message(message: MessageSchema, db: Session = Depends(get_db)):
    try:
        db_message = Message(role='user', content=message.message, conversation_id=None)
        db.add(db_message)
        db.commit()
        logger.info(f"Message created: {message.message[:50]}...")
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating message: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/messages", response_model=List[MessageResponse])
async def get_messages(db: Session = Depends(get_db)):
    try:
        messages = db.query(Message).order_by(Message.id.desc()).all()
        return [
            MessageResponse(
                id=msg.id,
                role=msg.role,
                content=msg.content,
                conversation_id=msg.conversation_id
            )
            for msg in messages
        ]
    except Exception as e:
        logger.error(f"Error fetching messages: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# CONVERSATION ENDPOINTS
# ============================================================================
@app.post("/conversations")
async def create_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_db)
):
    try:
        title = payload.title or "New Conversation"
        conv = Conversation(title=title)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        logger.info(f"Conversation created: {conv.id} - {title}")
        return {"id": conv.id, "title": conv.title}
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating conversation: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations", response_model=List[ConversationResponse])
async def list_conversations(db: Session = Depends(get_db)):
    try:
        convs = db.query(Conversation).order_by(Conversation.created_at.desc()).all()
        result = []
        
        for c in convs:
            count = db.query(Message).filter(Message.conversation_id == c.id).count()
            last = db.query(Message)\
                .filter(Message.conversation_id == c.id)\
                .order_by(Message.id.desc())\
                .first()
            
            preview = last.content[:200] if last and last.content else ""
            
            result.append(
                ConversationResponse(
                    id=c.id,
                    title=c.title,
                    message_count=count,
                    preview=preview
                )
            )
        
        return result
    except Exception as e:
        logger.error(f"Error listing conversations: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{conv_id}", response_model=ConversationDetailResponse)
async def get_conversation(conv_id: int, db: Session = Depends(get_db)):
    try:
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
        
        msgs = db.query(Message)\
            .filter(Message.conversation_id == conv_id)\
            .order_by(Message.id.asc())\
            .all()
        
        return ConversationDetailResponse(
            id=conv.id,
            title=conv.title,
            messages=[
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat()
                }
                for m in msgs
            ]
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching conversation {conv_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# CHAT ENDPOINT (OpenAI Integration)
# ============================================================================
@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, db: Session = Depends(get_db)):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY not configured")
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY not set in environment"
        )

    model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            conv_id = req.conversation_id
            is_new_conversation = False
            
            # Create conversation if not provided
            if conv_id is None:
                # Generate contextual title from first message
                title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
                conv = Conversation(title=title)
                db.add(conv)
                db.commit()
                db.refresh(conv)
                conv_id = conv.id
                is_new_conversation = True
                logger.info(f"Created new conversation: {conv_id} with title: {title}")
            else:
                existing = db.query(Conversation).filter(Conversation.id == conv_id).first()
                if not existing:
                    title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
                    conv = Conversation(id=conv_id, title=title)
                    db.add(conv)
                    db.commit()
                    is_new_conversation = True
                    logger.info(f"Created conversation with ID: {conv_id} and title: {title}")

            # Retrieve conversation history
            previous_messages = db.query(Message)\
                .filter(Message.conversation_id == conv_id)\
                .order_by(Message.id.asc())\
                .all()

            # Build messages array with context
            messages = [
                {"role": "system", "content": "You are a helpful assistant."}
            ]
            
            for msg in previous_messages:
                messages.append({"role": msg.role, "content": msg.content})
            
            messages.append({"role": "user", "content": req.message})

            # Save user message
            user_msg = Message(
                conversation_id=conv_id,
                role='user',
                content=req.message
            )
            db.add(user_msg)
            db.commit()
            logger.info(f"User message saved to conversation {conv_id}")

            # Prepare OpenAI request
            payload = {
                "model": model,
                "messages": messages,
                "max_tokens": 800,
                "temperature": 0.7,
            }

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }

            # Call OpenAI API
            logger.info(f"Calling OpenAI API with model {model}")
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json=payload,
                headers=headers
            )
            r.raise_for_status()
            data = r.json()
            
            # Extract assistant response
            assistant_text = ""
            if "choices" in data and len(data["choices"]) > 0:
                choice = data["choices"][0]
                if "message" in choice and "content" in choice["message"]:
                    assistant_text = choice["message"]["content"]
                elif "text" in choice:
                    assistant_text = choice["text"]

            if not assistant_text:
                logger.warning("Empty response from OpenAI")
                assistant_text = "I apologize, but I couldn't generate a response."

            # Save assistant response
            assistant_msg = Message(
                conversation_id=conv_id,
                role='assistant',
                content=assistant_text
            )
            db.add(assistant_msg)
            db.commit()
            logger.info(f"Assistant response saved to conversation {conv_id}")

            # Update conversation title based on context (after 3+ messages)
            await update_conversation_title(conv_id, db, api_key)

            # Get updated conversation for response
            conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
            
            # Return response with updated title
            response_data = ChatResponse(
                reply=assistant_text, 
                conversation_id=conv_id,
                title=conv.title if conv else None
            )

            return response_data
            
        except httpx.HTTPStatusError as e:
            db.rollback()
            logger.error(f"OpenAI API error: {str(e)}")
            raise HTTPException(
                status_code=502,
                detail=f"Upstream API error: {str(e)}"
            )
        except Exception as e:
            db.rollback()
            logger.error(f"Chat error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)