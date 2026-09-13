def run(state: dict) -> dict:
    print("\n============ General Response Stage =============")

    response = "How can I help you today with Scrum?"

    print("========== GENERAL RESPONSE ==========")
    print(response)
    print("======================================")

    state["response"] = response

    return state
