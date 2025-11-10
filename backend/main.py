from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # React app address
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database configuration
DATABASE_URL = "postgresql://postgres:postgres@db:5432/postgres"
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Message model
class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text)

# Create tables
Base.metadata.create_all(bind=engine)

# Request model
class MessageSchema(BaseModel):
    message: str

@app.post("/message")
async def create_message(message: MessageSchema):
    db = SessionLocal()
    try:
        db_message = Message(content=message.message)
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
        return [{"id": msg.id, "content": msg.content} for msg in messages]
    except Exception as e:
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()