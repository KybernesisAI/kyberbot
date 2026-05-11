import { defineModule } from "als:authoring";

export const module = defineModule({
  "dependencies": [],
  "delamains": {
    "kyberbot-factory-jobs": {
      "path": "delamains/kyberbot-factory-jobs/delamain.ts"
    }
  },
  "entities": {
    "job": {
      "source_format": "markdown",
      "path": "{id}.md",
      "identity": {
        "id_field": "id"
      },
      "fields": {
        "id": {
          "type": "id",
          "allow_null": false
        },
        "title": {
          "type": "string",
          "allow_null": false
        },
        "description": {
          "type": "string",
          "allow_null": false
        },
        "type": {
          "type": "enum",
          "allow_null": false,
          "allowed_values": [
            "feature",
            "enhancement",
            "defect",
            "hotfix",
            "security",
            "chore"
          ]
        },
        "status": {
          "type": "delamain",
          "allow_null": false,
          "delamain": "kyberbot-factory-jobs"
        },
        "created": {
          "type": "date",
          "allow_null": false
        },
        "updated": {
          "type": "date",
          "allow_null": false
        },
        "tags": {
          "type": "list",
          "allow_null": true,
          "items": {
            "type": "string"
          }
        }
      },
      "body": {
        "title": {
          "source": {
            "kind": "template",
            "parts": [
              {
                "kind": "field",
                "field": "id"
              },
              {
                "kind": "literal",
                "value": ": "
              },
              {
                "kind": "field",
                "field": "title"
              }
            ]
          }
        },
        "sections": [
          {
            "name": "PURPOSE",
            "allow_null": false,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "code": {
                  "require_language": true
                }
              }
            },
            "guidance": {
              "include": "what this job is, why it exists, what problem it solves",
              "exclude": "implementation details, status history"
            }
          },
          {
            "name": "CURRENT_STATE",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "snapshot of what exists before work begins, audits, inventories",
              "exclude": "target state, historical changes"
            }
          },
          {
            "name": "REQUIREMENTS",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                }
              }
            },
            "guidance": {
              "include": "constraints, prerequisites, guardrails, acceptance criteria, phased requirements",
              "exclude": "design rationale, status history"
            }
          },
          {
            "name": "RESEARCH",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "findings from the research phase, evidence, conclusions, prior art",
              "exclude": "research questions, plan details"
            }
          },
          {
            "name": "RESEARCH_QUESTIONS",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "questions raised during research, operator answers, decision rationale",
              "exclude": "research findings, plan details"
            }
          },
          {
            "name": "PLAN",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "agent-authored implementation plan, design decisions, execution steps",
              "exclude": "requirements, review findings, test results"
            }
          },
          {
            "name": "PLAN_QUESTIONS",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "questions raised during planning, operator answers, decision rationale",
              "exclude": "the plan itself, research findings"
            }
          },
          {
            "name": "ARCHITECTURE",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "design decisions, rationale, target state, standards and conventions, key patterns",
              "exclude": "execution steps, status history"
            }
          },
          {
            "name": "REVIEW",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "dated review findings per pass, pass/fail reasoning, issues identified",
              "exclude": "implementation details, deployment details"
            }
          },
          {
            "name": "TESTS",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "dated test runs, suites authored, command output summaries, pass/fail counts, failure narratives that justified test-input gating",
              "exclude": "review findings, deployment details, implementation plan"
            }
          },
          {
            "name": "DEPLOYMENT",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                }
              }
            },
            "guidance": {
              "include": "deployment target, deployment details, environment, verification results",
              "exclude": "implementation plan, review findings"
            }
          },
          {
            "name": "REFERENCES",
            "allow_null": true,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "table": {
                  "syntax": "gfm"
                }
              }
            },
            "guidance": {
              "include": "links to related artifacts, file paths, URLs, related items",
              "exclude": "substantive content"
            }
          },
          {
            "name": "ACTIVITY_LOG",
            "allow_null": false,
            "content": {
              "mode": "freeform",
              "blocks": {
                "paragraph": {},
                "bullet_list": {},
                "ordered_list": {},
                "table": {
                  "syntax": "gfm"
                },
                "heading": {
                  "min_depth": 3,
                  "max_depth": 4
                },
                "code": {
                  "require_language": true
                },
                "blockquote": {}
              }
            },
            "guidance": {
              "include": "dated append-only history of actions, decisions, session handoff context",
              "exclude": "evergreen content, requirements, descriptions"
            }
          }
        ]
      }
    }
  }
} as const);

export default module;
