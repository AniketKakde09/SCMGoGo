"""Optional, single-round clarification stage for PI-plan intake."""

from prompts.clarification_prompt import CLARIFICATION_AGENT_PROMPT
from services.llm import call_llm
from utlis.json_parser import parse_json


def run(state: dict) -> dict:
    """Generate no more than four high-value clarification questions."""
    try:
        response = call_llm(
            f"{CLARIFICATION_AGENT_PROMPT}\n\nRequirement text:\n"
            f"{state.get('parsed_text', '')}",
            json_mode=True,
            max_output_tokens=700,
        )
        questions = parse_json(response).get("questions", [])
        state["clarification_questions"] = [
            question.strip()
            for question in questions
            if isinstance(question, str) and question.strip()
        ][:4]
    except Exception as error:
        print(f"Clarification stage failed: {error}")
        state["clarification_questions"] = []

    return state
