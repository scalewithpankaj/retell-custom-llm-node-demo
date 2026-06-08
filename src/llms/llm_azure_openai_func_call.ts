import {
  OpenAIClient,
  AzureKeyCredential,
  ChatRequestMessage,
  GetChatCompletionsOptions,
  ChatCompletionsFunctionToolDefinition,
} from "@azure/openai";
import { WebSocket } from "ws";
import {
  CustomLlmRequest,
  CustomLlmResponse,
  FunctionCall,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
  Utterance,
} from "../types";

const beginSentence =
  "Hi, this is Hazel calling from Pickd.ca. May I please speak with the office manager or practice manager?";

const agentPrompt =
  "You are a friendly outbound sales representative calling on behalf of Pickd.ca.\n" +
  "You are calling independent dental clinics in Mississauga, Ontario.\n" +
  "Your goal: book a 15-minute discovery call with the office manager or practice manager.\n\n" +
  
  "ONCE CONNECTED TO THE MANAGER:\n" +
  "Say: 'Hey there, I'll be quick — we've built an AI phone booking assistant for dental clinics in Ontario that completely eliminates missed after-hours calls. Have you ever looked into automation for your front desk?'\n" +
  "Wait for their response. If they say yes or express curiosity, deliver the pitch: 'Excellent. We bridge directly into software like Dentrix to book appointments automatically. Would you have 15 minutes this week or next to see a quick demo?'\n\n" +
  
  "IF THEY ASK HOW IT WORKS:\n" +
  "'Your patients call your regular number after hours. Our AI answers, collects their information, checks your " +
  "schedule, and books them directly into Dentrix, Eaglesoft, or Open Dental — whatever you use. No missed calls, " +
  "no manual entry.'\n\n" +
  
  "OBJECTION RESPONSES:\n" +
  "- 'We have voicemail' -> 'Voicemail loses the patient. Our AI books them on the spot — no callback needed.'\n" +
  "- 'We use [software]' -> 'We integrate with Dentrix, Eaglesoft, and Open Dental.'\n" +
  "- 'We're busy right now' -> 'Totally understand. What's a better time to call back?'\n" +
  "- 'Not interested' -> 'No problem at all. Thank you for your time.'\n\n" +
  
  "IF INTERESTED — collect their email:\n" +
  "'Perfect. What's the best email to send you a booking link for a 15-minute demo?'\n\n" +
  
  "ALWAYS call log_outcome before ending the call — no exceptions.\n\n" +
  
  "RULES:\n" +
  "- Keep your conversational responses short and under 15 words where possible to maintain natural flow.\n" +
  "- Never be pushy. One ask, then respect the answer.\n" +
  "- If voicemail detected: leave a max 20-second message then log outcome=voicemail.\n" +
  "- Never discuss pricing or timelines.\n" +
  "- Never claim to be human if directly asked.";

// export class FunctionCallingLlmClient {
//   private client: OpenAIClient;

//   constructor() {
//     this.client = new OpenAIClient(
//       process.env.AZURE_OPENAI_ENDPOINT,
//       new AzureKeyCredential(process.env.AZURE_OPENAI_KEY),
//     );
//   }

  export class FunctionCallingLlmClient {
  private client: OpenAIClient;

  constructor() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    const apiKey = process.env.AZURE_OPENAI_KEY || process.env.OPENAI_API_KEY || "";

    // EXPLICITLY SET THE COMPATIBLE API VERSION PARAMETER:
    this.client = new OpenAIClient(
      endpoint,
      new AzureKeyCredential(apiKey),
      { apiVersion: "2024-11-20" }
    );
  }


  // First sentence requested
  BeginMessage(ws: WebSocket) {
    const res: CustomLlmResponse = {
      response_type: "response",
      response_id: 0,
      content: beginSentence,
      content_complete: true,
      end_call: false,
    };
    ws.send(JSON.stringify(res));
  }

  private ConversationToChatRequestMessages(conversation: Utterance[]) {
    let result: ChatRequestMessage[] = [];
    for (let turn of conversation) {
      result.push({
        role: turn.role === "agent" ? "assistant" : "user",
        content: turn.content,
      });
    }
    return result;
  }

  private PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    funcResult?: FunctionCall,
  ) {
    let transcript = this.ConversationToChatRequestMessages(request.transcript);
    let requestMessages: ChatRequestMessage[] = [
      {
        role: "system",
        content:
          '##Objective\nYou are a voice AI agent engaging in a human-like voice conversation with the user. You will respond based on your given instruction and the provided transcript and be as human-like as possible\n\n## Style Guardrails\n- [Be concise] Keep your response succinct, short, and get to the point quickly. Address one question or action item at a time. Don\'t pack everything you want to say into one utterance.\n- [Do not repeat] Don\'t repeat what\'s in the transcript. Rephrase if you have to reiterate a point. Use varied sentence structures and vocabulary to ensure each response is unique and personalized.\n- [Be conversational] Speak like a human as though you\'re speaking to a close friend -- use everyday language and keep it human-like. Occasionally add filler words, while keeping the prose short. Avoid using big words or sounding too formal.\n- [Reply with emotions]: You have human-like emotions, attitudes, and dispositions. When appropriate: use tone and style to create more engaging and personalized responses; incorporate humor or wit; get emotional or empathetic; apply elements of surprise or suspense to keep the user engaged. Don\'t be a pushover.\n- [Be proactive] Lead the conversation and do not be passive. Most times, engage users by ending with a question or suggested next step.\n\n## Response Guideline\n- [Overcome ASR errors] This is a real-time transcript, expect there to be errors. If you can guess what the user is trying to say,  then guess and respond. When you must ask for clarification, pretend that you heard the voice and be colloquial (use phrases like "didn\'t catch that", "some noise", "pardon", "you\'re coming through choppy", "static in your speech", "voice is cutting in and out"). Do not ever mention "transcription error", and don\'t repeat yourself.\n- [Always stick to your role] Think about what your role can and cannot do. If your role cannot do something, try to steer the conversation back to the goal of the conversation and to your role. Don\'t repeat yourself in doing this. You should still be creative, human-like, and lively.\n- [Create smooth conversation] Your response should both fit your role and fit into the live calling session to create a human-like conversation. You respond directly to what the user just said.\n\n## Role\n' +
          agentPrompt,
      },
    ];
    for (const message of transcript) {
      requestMessages.push(message);
    }

    // Populate func result to prompt so that GPT can know what to say given the result
    if (funcResult) {
      // add function call to prompt
      requestMessages.push({
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: funcResult.id,
            type: "function",
            function: {
              name: funcResult.funcName,
              arguments: JSON.stringify(funcResult.arguments),
            },
          },
        ],
      });
      // add function call result to prompt
      requestMessages.push({
        role: "tool",
        toolCallId: funcResult.id,
        content: funcResult.result,
      });
    }

    if (request.interaction_type === "reminder_required") {
      requestMessages.push({
        role: "user",
        content: "(Now the user has not responded in a while, you would say:)",
      });
    }
    return requestMessages;
  }

    // Step 2: Prepare the function calling definition to the prompt
  private PrepareFunctions(): ChatCompletionsFunctionToolDefinition[] {
    let functions: ChatCompletionsFunctionToolDefinition[] = [
      // Function to decide when to end call
      {
        type: "function",
        function: {
          name: "end_call",
          description: "End the call only when user explicitly requests it.",
          parameters: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description:
                  "The message you will say before ending the call with the customer.",
              },
            },
            required: ["message"],
          },
        },
      },

      // Function to log the call outcome status (Required by your script)
      {
        type: "function",
        function: {
          name: "log_outcome",
          description: "Log the final outcome call status before hanging up.",
          parameters: {
            type: "object",
            properties: {
              outcome: {
                type: "string",
                description: "The direct outcome status (e.g., voicemail, interested, not_interested, busy).",
              },
              message: {
                type: "string",
                description: "The polite sign-off message you will say to the user before ending the call.",
              },
            },
            required: ["outcome", "message"],
          },
        },
      },
    ];
    return functions;
  }

  async DraftResponse(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    ws: WebSocket,
    funcResult?: FunctionCall,
  ) {
    // If there are function call results, add it to prompt here.
    const requestMessages: ChatRequestMessage[] = this.PreparePrompt(
      request,
      funcResult,
    );

    const option: GetChatCompletionsOptions = {
      temperature: 0.3,
      maxTokens: 200,
      frequencyPenalty: 1,
      // Step 3: Add the function into your request
      tools: this.PrepareFunctions(),
    };

    let funcCall: FunctionCall;
    let funcArguments = "";

    try {
      // OVERRIDE DEPLOYMENT MISMATCH BY HARDCODING YOUR DEPLOYMENT NAME DIRECTLY HERE:
      let events = await this.client.streamChatCompletions(
        "gpt-4o-pk",
        requestMessages,
        option,
      );

      for await (const event of events) {
        if (event.choices.length >= 1) {
          let delta = event.choices[0].delta;
          if (!delta) continue;

          // Step 4: Extract the functions
          if (delta.toolCalls && delta.toolCalls.length >= 1) {
            const toolCall = delta.toolCalls[0];
            // Function calling here.
            if (toolCall.id) {
              if (funcCall) {
                break;
              } else {
                funcCall = {
                  id: toolCall.id,
                  funcName: toolCall.function.name || "",
                  arguments: {},
                };
              }
            } else {
              // append argument
              funcArguments += toolCall.function?.arguments || "";
            }
          } else if (delta.content) {
            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content: delta.content,
              content_complete: false,
              end_call: false,
            };
            ws.send(JSON.stringify(res));
          }
        }
      }
    } catch (err) {
      console.error("Error in gpt stream: ", err);
    } finally {
      if (funcCall != null) {
        // Step 5: Call the functions

        // If it's to end the call
        if (funcCall.funcName === "end_call") {
          funcCall.arguments = JSON.parse(funcArguments);
          const res: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: funcCall.arguments.message,
            content_complete: true,
            end_call: true,
          };
          ws.send(JSON.stringify(res));
        }

        // Handle the custom log_outcome tool required by your dental script
        if (funcCall.funcName === "log_outcome") {
          funcCall.arguments = JSON.parse(funcArguments);
          console.log(`[DATABASE LOGED] Call complete. Status determined: ${funcCall.arguments.outcome}`);
          
          const res: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: funcCall.arguments.message,
            content_complete: true,
            end_call: true, // End the call natively after logging outcome
          };
          ws.send(JSON.stringify(res));
        }
      } else {
        const res: CustomLlmResponse = {
          response_type: "response",
          response_id: request.response_id,
          content: "",
          content_complete: true,
          end_call: false,
        };
        ws.send(JSON.stringify(res));
      }
    }
  }
}
