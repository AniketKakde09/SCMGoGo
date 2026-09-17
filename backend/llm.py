from __future__ import annotations

import json
import logging
import os
from typing import Any

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


logger = logging.getLogger(__name__)


class LLMClient:
    """Provider-neutral LLM client.

    Supported providers:
      - none: disabled
      - groq: Groq API using GROQ_API_KEY
      - bedrock: AWS Bedrock Converse API using the normal AWS credential chain
      - llmas: VW Group LLM API using OAuth client credentials and LLMAS API key

    The LLM is an interpretation layer only. Source-of-truth facts should come
    from the workbook, Chroma, and NetworkX evidence supplied by the caller.
    """

    def __init__(self, provider: str | None = None):
        self.provider = (
            provider or os.getenv("LLM_PROVIDER", "none")
        ).strip().lower()

        self.client = None

        if self.provider == "groq":
            self._init_groq()
        elif self.provider == "bedrock":
            self._init_bedrock()
        elif self.provider == "llmas":
            self._init_llmas()
        elif self.provider != "none":
            raise ValueError(
                "LLM_PROVIDER must be one of: none, groq, bedrock, llmas"
            )

    def _init_groq(self) -> None:
        api_key = os.getenv("GROQ_API_KEY")

        if not api_key:
            raise RuntimeError(
                "LLM_PROVIDER=groq requires GROQ_API_KEY"
            )

        from groq import Groq

        self.client = Groq(api_key=api_key)

    def _init_bedrock(self) -> None:
        import boto3

        region = (
            os.getenv("AWS_REGION")
            or os.getenv("AWS_DEFAULT_REGION")
        )

        self.client = boto3.client(
            "bedrock-runtime",
            region_name=region,
        )

    def _init_llmas(self) -> None:
        """Initialize the VW Group LLMAS OpenAI-compatible client."""
        import httpx
        from openai import OpenAI

        client_id = os.getenv("LLMAS_CLIENT_ID")
        client_secret = os.getenv("LLMAS_CLIENT_SECRET")
        api_key = os.getenv("LLMAS_API_KEY")

        if not client_id:
            raise RuntimeError(
                "LLM_PROVIDER=llmas requires LLMAS_CLIENT_ID"
            )

        if not client_secret:
            raise RuntimeError(
                "LLM_PROVIDER=llmas requires LLMAS_CLIENT_SECRET"
            )

        if not api_key:
            raise RuntimeError(
                "LLM_PROVIDER=llmas requires LLMAS_API_KEY"
            )

        token_url = os.getenv(
            "LLMAS_TOKEN_URL",
            "https://idp.cloud.vwgroup.com/auth/realms/"
            "kums-mfa/protocol/openid-connect/token",
        )

        base_url = os.getenv(
            "LLMAS_BASE_URL",
            "https://llmapi.ai.vwgroup.com",
        )

        try:
            response = httpx.post(
                token_url,
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "grant_type": "client_credentials",
                },
                timeout=30.0,
            )

            response.raise_for_status()
            token_response = response.json()

        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                "Failed to authenticate with LLMAS identity provider. "
                f"HTTP status: {exc.response.status_code}"
            ) from exc

        except httpx.RequestError as exc:
            raise RuntimeError(
                f"Failed to connect to the LLMAS identity provider: {exc}"
            ) from exc

        except ValueError as exc:
            raise RuntimeError(
                "LLMAS identity provider returned an invalid JSON response."
            ) from exc

        access_token = token_response.get("access_token")

        if not access_token:
            raise RuntimeError(
                "LLMAS identity provider response does not contain "
                "an access_token."
            )

        self.client = OpenAI(
            api_key=access_token,
            base_url=base_url,
            default_headers={
                "X-LLM-API-CLIENT-ID": f"Bearer {api_key}",
            },
            timeout=60.0,
        )

    @property
    def enabled(self) -> bool:
        return self.provider != "none"

    def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str | None = None,
        temperature: float = 0.0,
        max_tokens: int = 2000,
    ) -> str:
        if self.provider == "none":
            raise RuntimeError(
                "LLM provider is disabled (LLM_PROVIDER=none)"
            )

        if self.provider == "groq":
            return self._generate_groq(
                system_prompt,
                user_prompt,
                model,
                temperature,
                max_tokens,
            )

        if self.provider == "bedrock":
            return self._generate_bedrock(
                system_prompt,
                user_prompt,
                model,
                temperature,
                max_tokens,
            )

        if self.provider == "llmas":
            return self._generate_llmas(
                system_prompt,
                user_prompt,
                model,
                temperature,
                max_tokens,
            )

        raise RuntimeError(
            f"Unsupported LLM provider: {self.provider}"
        )

    def _generate_groq(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None,
        temperature: float,
        max_tokens: int,
    ) -> str:
        model = model or os.getenv(
            "GROQ_MODEL",
            "openai/gpt-oss-120b",
        )

        response = self.client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                },
            ],
            temperature=temperature,
            max_completion_tokens=max_tokens,
        )

        choice = response.choices[0]

        if choice.finish_reason == "length":
            raise ValueError(
                "Groq stopped generation because the output token limit "
                "was reached. Reduce the requested ticket count or "
                "generate tickets in smaller batches."
            )

        return choice.message.content or ""

    def _generate_bedrock(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None,
        temperature: float,
        max_tokens: int,
    ) -> str:
        model = model or os.getenv(
            "BEDROCK_MODEL",
            "amazon.nova-micro-v1:0",
        )

        response = self.client.converse(
            modelId=model,
            system=[
                {
                    "text": system_prompt,
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "text": user_prompt,
                        }
                    ],
                }
            ],
            inferenceConfig={
                "maxTokens": max_tokens,
                "temperature": temperature,
            },
        )

        content = (
            response
            .get("output", {})
            .get("message", {})
            .get("content", [])
        )

        return "\n".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
        ).strip()

    def _generate_llmas(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None,
        temperature: float,
        max_tokens: int,
        *,
        json_mode: bool = False,
    ) -> str:
        model = (
            model
            or os.getenv("LLMAS_MODEL")
            or os.getenv("MODEL_ID")
        )

        if not model:
            raise RuntimeError(
                "LLM_PROVIDER=llmas requires LLMAS_MODEL or MODEL_ID"
            )

        request: dict[str, Any] = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                },
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if json_mode:
            request["response_format"] = {
                "type": "json_object",
            }

        response = self.client.chat.completions.create(**request)

        if not response.choices:
            raise ValueError(
                "LLMAS returned a response without any choices."
            )

        choice = response.choices[0]

        if choice.finish_reason == "length":
            raise ValueError(
                "LLMAS stopped generation because the output token limit "
                "was reached. Reduce the requested ticket count or "
                "increase max_tokens."
            )

        return choice.message.content or ""

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str | None = None,
        temperature: float = 0.0,
        max_tokens: int = 2000,
    ) -> dict[str, Any]:
        if self.provider == "llmas":
            raw = self._generate_llmas(
                system_prompt,
                user_prompt,
                model,
                temperature,
                max_tokens,
                json_mode=True,
            ).strip()
        else:
            raw = self.generate(
                system_prompt,
                user_prompt,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            ).strip()

        logger.info(
            "LLM JSON response: provider=%s, length=%d, empty=%s",
            self.provider,
            len(raw),
            not bool(raw),
        )

        if not raw:
            raise ValueError("LLM returned an empty response.")

        # Remove a complete Markdown code fence, if present.
        if raw.startswith("```"):
            lines = raw.splitlines()

            if (
                len(lines) >= 3
                and lines[-1].strip() == "```"
            ):
                raw = "\n".join(lines[1:-1]).strip()

        try:
            parsed = json.loads(raw)

        except json.JSONDecodeError as exc:
            logger.warning(
                "LLM returned invalid JSON: "
                "line=%d, column=%d, length=%d",
                exc.lineno,
                exc.colno,
                len(raw),
            )

            raise ValueError(
                "LLM returned invalid JSON. The response may be "
                "truncated or may not follow the requested format."
            ) from exc

        if not isinstance(parsed, dict):
            raise ValueError(
                f"LLM returned {type(parsed).__name__}; "
                "expected a JSON object."
            )

        logger.info(
            "LLM JSON parsed successfully. Keys: %s",
            list(parsed.keys()),
        )

        return parsed