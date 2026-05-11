import { defineSystem } from "als:authoring";

export const system = defineSystem({
  "als_version": 3,
  "system_id": "kyberbot",
  "modules": {
    "kyberbot-factory": {
      "path": "kyberbot-factory/jobs",
      "version": 2,
      "description": "factory for kyberbot",
      "skills": [
        "kyberbot-factory-console",
        "kyberbot-factory-inspect"
      ]
    }
  }
} as const);

export default system;
