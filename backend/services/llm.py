"""LLM service."""

from openai import OpenAI
from config import API_KEY, MODEL_ID

if not API_KEY:
    raise ValueError(
        "API_KEY is required. "
        "Set it in your environment or .env file."
    )

client = OpenAI(
    api_key=API_KEY,
    base_url="https://api.groq.com/openai/v1",
)

def call_llm(
    prompt: str,
    json_mode: bool = False,
    max_output_tokens: int = 5000,
) -> str:
    """Send a prompt to the LLM and return plain text output."""
    kwargs = {
        "model": MODEL_ID,
        "input": prompt,
        "max_output_tokens": max_output_tokens,
    }

    if json_mode:
        kwargs["text"] = {
            "format": {
                "type": "json_object"
            }
        }

    response = client.responses.create(
        **kwargs
    )

    return response.output_text