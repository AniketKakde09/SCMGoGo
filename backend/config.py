"""Application configuration."""

import os
from dotenv import load_dotenv

load_dotenv()

LLM_PROVIDER = os.getenv(
    "LLM_PROVIDER",
    "openai"
)

MODEL_ID = os.getenv(
    "MODEL_ID",
    "llama-3.3-70b-versatile"
)

API_KEY = os.getenv(
    "API_KEY"
)

AWS_REGION = os.getenv(
    "AWS_REGION",
    "us-east-1"
)

DATABASE_URL = os.getenv(
    "DATABASE_URL"
)

LOG_LEVEL = os.getenv(
    "LOG_LEVEL",
    "INFO"
)

# Kept for future Jira MCP integration.
ATLASSIAN_MCP_URL = os.getenv(
    "JIRA_MCP_SERVER"
)