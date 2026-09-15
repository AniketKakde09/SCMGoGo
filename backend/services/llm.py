"""LLM service."""

from openai import OpenAI
from config import CLIENT_ID, CLIENT_SECRET, API_KEY, MODEL_ID
import httpx

if not API_KEY:
    raise ValueError(
        "API_KEY is required. "
        "Set it in your environment or .env file."
    )

## GROQ API

# client = OpenAI(
#     api_key=API_KEY,
#     base_url="https://api.groq.com/openai/v1",
# )

## LLMAS API

def get_token() -> str:
    response = httpx.post(
        "https://idp.cloud.vwgroup.com/auth/realms/kums-mfa/protocol/openid-connect/token",
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "client_credentials",
        },
    )

    response.raise_for_status()
    return response.json()["access_token"]


token = get_token()

client = OpenAI(
    api_key=token,
    base_url="https://llmapi.ai.vwgroup.com",
    default_headers={
        "X-LLM-API-CLIENT-ID": f"Bearer {API_KEY}"
    },
)

## Common function

def call_llm(
    prompt: str,
    json_mode: bool = False,
    max_output_tokens: int = 5000,
) -> str:
    """Send a prompt to the LLM and return plain text output."""
    kwargs = {
        "model": MODEL_ID,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_output_tokens,
    }

    if json_mode:
        kwargs["response_format"] = {
            "type": "json_object"
        }

    response = client.chat.completions.create(
        **kwargs
    )

    return response.choices[0].message.content