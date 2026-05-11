// Strip the API key before the SDK loads so dispatchers stay on Max routing.
delete process.env.ANTHROPIC_API_KEY;
