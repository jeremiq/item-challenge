# 📢 Context 📢 

Below is a coding challenge that I found. I used a swarm of agents to solve the problem with a few back-and-forth interactions to set the architecture, clean up the code, and audit for best practices and security vulnerabilities. Using agentic AI was very much *not* in the spirit of the original challenge, but was excellent practice for interacting with subagents, remote coding sessions, and general modern agentic development. It even mostly works! 

## Session summary
### Models

| Phase | Model |
|---|---|
| Initial 3-way parallel implementation, most Q&A, final git/fork/PR work | **Sonnet 5** (`claude-sonnet-5`) |
| `/simplify` cleanup pass onward through the security review, bug fixes, and diagrams | **Opus 5** (`claude-opus-5`) |

T
### Agents — 9 subagents spawned, all background

| Wave | Agents | Combined subagent tokens | Wall time (sum, mostly parallel) |
|---|---|---|---|
| Implementation (parallel) | API handlers, CDK infra, DynamoDB storage | 364,783 | 20.3 min |
| `/simplify` review (parallel) | Reuse, Simplification, Efficiency, Altitude | 394,989 | 7.3 min |
| Security review (sequential) | Vuln identification, false-positive filter | 181,465 | 3.8 min |

**Total: 941,237 subagent tokens, 196 tool calls, ~31.3 min of measured agent compute** (heavily parallelized, so wall-clock was much less).


# Item Challenge

Welcome! This is a take-home coding assignment for a software engineering position. In this challenge, you'll be building a simplified version of an exam item management API with cloud infrastructure.

Once you're ready to get started, read through [GETTING_STARTED.md](GETTING_STARTED.md).

## Your Task (1-3 hours)

**Please do not spend more than 3 hours on this. It is not expected for your solution to be perfectly polished and we want to be respectful of your time.**

Build a simplified exam item management system that demonstrates your ability to design scalable, secure APIs with proper cloud infrastructure.

### 1. API Implementation (TypeScript + Node.js)

Create API endpoints for managing exam items:

```
POST   /api/items              - Create a new exam item
GET    /api/items/:id          - Retrieve an item
PUT    /api/items/:id          - Update an item
GET    /api/items              - List items (with pagination)
POST   /api/items/:id/versions - Create a new version of an item
GET    /api/items/:id/audit    - Get audit trail for an item
```

**Goals:**

- Write handlers designed for AWS Lambda (serverless architecture)
- Implement proper error handling and validation
- Use appropriate HTTP status codes for responses
- Focus on 2-3 endpoints working well rather than all 6 partially done

**Note:** A local development server is provided for testing. Your handlers should be written with Lambda deployment in mind, but you'll test them locally.

### 2. Infrastructure as Code

Define the cloud infrastructure needed to deploy this system using **either** AWS CDK **or** Terraform (your choice).

**Goals:**

- Use AWS CDK (TypeScript preferred) **OR** Terraform
- Define resources: Lambda functions, API Gateway, DynamoDB (optional), IAM roles, CloudWatch logs
- Include comments explaining your design choices
- Define environment-specific configurations
- You do **not** need to actually deploy - just provide valid infrastructure code

**Validation:**

- For CDK: Run `cdk synth` to validate
- For Terraform: Run `terraform plan` to validate

### 3. Data Modeling

Design storage for exam items with this structure:

```ts
{
  id: string,
  subject: string,           // e.g., "AP Biology", "AP Calculus"
  itemType: string,          // "multiple-choice", "free-response", "essay"
  difficulty: number,        // 1-5
  content: {
    question: string,
    options?: string[],      // For multiple choice
    correctAnswer: string,
    explanation: string
  },
  metadata: {
    author: string,
    created: timestamp,
    lastModified: timestamp,
    version: number,
    status: string,          // "draft", "review", "approved", "archived"
    tags: string[]
  },
  securityLevel: string      // "standard", "secure", "highly-secure"
}
```

**Goals:**

- Support versioning (keep history of changes)
- Design appropriate DynamoDB keys and indexes (documented in ARCHITECTURE.md)
- Implement basic CRUD operations

**Note:** An in-memory storage implementation is provided for local testing. You can optionally implement DynamoDB storage if you want to go the extra mile.

### 4. Architectural Decision Document

Include a brief `ARCHITECTURE.md` file (template provided) covering:

- Data model design and DynamoDB schema
- Infrastructure choices and rationale
- Scalability & performance considerations
- Security approach
- Trade-offs and future improvements

## 🚀 Project Setup

See [GETTING_STARTED.md](GETTING_STARTED.md) for detailed setup instructions.

**Quick start:**

```bash
pnpm install
pnpm dev
```

## What We're Evaluating

- **Code Quality:** Clean, readable, maintainable code
- **AWS Knowledge:** Proper use of Lambda, API Gateway, DynamoDB, IAM, CloudWatch
- **Infrastructure as Code:** Well-structured CDK/Terraform with best practices
- **NoSQL Design:** Appropriate key design and access patterns
- **Testing:** Well-structured tests with good coverage of core functionality (optional but encouraged)
- **Prioritization:** How you approach the time constraint

## Submission

Please fork this repository and submit your completed solution by sharing your forked repo link with your recruiter.

### Include the following in your submission:

- Instructions on how to run your solution locally  
- Include a brief `ARCHITECTURE.md` describing your system’s structure and key components  
Good luck! We're excited to see your solution.

> See also the [Glossary](./GLOSSARY.md) for definitions of key terms used in this challenge.
