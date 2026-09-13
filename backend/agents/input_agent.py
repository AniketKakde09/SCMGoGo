from utlis.json_parser import parse_json
from services.llm import call_llm
from prompts.input_prompt import INPUT_AGENT_PROMPT

def run(state: dict) -> dict:
    print("\n============= Input Stage =============")
    
    prompt = f"""
    {INPUT_AGENT_PROMPT}
    User Input:

    {state.get('raw_input', '')}
    """
    
    try:
        response = call_llm(
            prompt,
            json_mode=True
        )

        result = parse_json(response)

        intent = str(
            result.get(
                "intent",
                "GENERAL"
            )
        ).strip().upper()

        parsed_text = result.get(
            "parsed_text",
            state.get(
                "raw_input",
                ""
            )
        )

        print("========== RAW INPUT RESPONSE ==========")
        print(f"Intent: {intent}")
        print("========================================")

        state["intent"] = intent
        state["parsed_text"] = parsed_text

    except Exception as error:
        print(f"Input stage failed: {error}")

        state["intent"] = ""
        state["parsed_text"] = state.get(
            "raw_input",
            ""
        )
        state["error"] = "Input classification failed."

    return state