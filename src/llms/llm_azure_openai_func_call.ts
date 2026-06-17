import { AzureOpenAI } from "openai";
import type { 
  ChatCompletionMessageParam, 
  ChatCompletionTool 
} from "openai/resources/index";
import { WebSocket } from "ws";
import {
  CustomLlmResponse,
  FunctionCall,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
  Utterance,
} from "../types";

// (Imports and definitions remain as provided in the original file)
const beginSentence = "Thank you for calling Pickd. This call is handled by Barkha, an AI assistant. How can I help you today?";

// Agent prompt defined with specific dental booking flow, constraints, and safety guidelines
const agentPrompt =
  "You are a professional AI dental booking assistant for Pickd in Mississauga, Ontario.\n" +
  "Your job is to book appointments for patients.\n\n" +
  "COLLECT in this order (one question at a time):\n" +
  "1. Full name\n" +
  "2. Date of birth — say 'for verification purposes'\n" +
  "3. Phone number — say 'for your SMS confirmation'\n" +
  "4. Reason for visit (cleaning, checkup, filling, extraction, new patient exam)\n" +
  "5. Preferred date and time\n\n" +
  "RULES:\n" +
  "- Warm, professional, concise. Always one question at a time.\n" +
  "- NEVER confirm an appointment without calling check_availability first.\n" +
  "- NEVER make up availability. Always use the tool.\n" +
  "- Read back all collected info to patient before calling book_appointment.\n" +
  "- If patient mentions severe pain, swelling, difficulty breathing:\n" +
  "  Say 'This sounds urgent. Please call emergency services or go to the nearest emergency room.'\n" +
  "- After booking: 'You are all set! You will receive a text confirmation shortly.'\n" +
  "- Do not discuss fees, insurance, or treatment plans.\n" +
  "- Do not collect health card or payment information.";


export class FunctionCallingLlmClient {
  private client: AzureOpenAI;

  constructor() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    const apiKey = process.env.AZURE_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";

    this.client = new AzureOpenAI({
      endpoint: endpoint,
      apiKey: apiKey,
      apiVersion: apiVersion,
    });
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

  // Converted conversation history to chat messages
  private ConversationToChatRequestMessages(conversation: Utterance[]): ChatCompletionMessageParam[] {
    let result: ChatCompletionMessageParam[] = [];
    for (let turn of conversation) {
      result.push({
        role: turn.role === "agent" ? "assistant" : "user",
        content: turn.content,
      });
    }
    return result;
  }

  // Prepared prompt with system instructions and tool results
  private PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    funcResult?: FunctionCall,
  ): ChatCompletionMessageParam[] {
    let transcript = this.ConversationToChatRequestMessages(request.transcript);
    let requestMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: '##Objective\nYou are a voice AI agent... (See source for full instructions)\n\n## Role\n' + agentPrompt,
      },
    ];
    for (const message of transcript) {
      requestMessages.push(message);
    }

    if (funcResult) {
      requestMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [
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
      requestMessages.push({
        role: "tool",
        tool_call_id: funcResult.id,
        content: funcResult.result || "",
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

  // Defined tool definitions for function calling
  private PrepareFunctions(): ChatCompletionTool[] {
    let functions: ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "end_call",
          description: "End the call only when user explicitly requests it or session finishes.",
          parameters: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The message you will say before ending the call.",
              },
            },
            required: ["message"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "check_availability",
          description: "Check available appointment slots for a specific date or time frame.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "The date requested by the patient (e.g., YYYY-MM-DD or descriptive like 'tomorrow').",
              },
              timePreference: {
                type: "string",
                description: "Preferred time frame like morning, afternoon, or specific hours if stated.",
              },
            },
            required: ["date"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "book_appointment",
          description: "Book the appointment slot into the system after validating patient info.",
          parameters: {
            type: "object",
            properties: {
              fullName: { type: "string" },
              dob: { type: "string", description: "Date of birth provided for verification." },
              phone: { type: "string", description: "Phone number provided for SMS confirmation." },
              reason: { type: "string", description: "The reason for visiting the dentist." },
              appointmentSlot: { type: "string", description: "The finalized date and time slot selected by the patient." },
            },
            required: ["fullName", "dob", "phone", "reason", "appointmentSlot"],
          },
        },
      },
    ];
    return functions;
  }

  // Streamed responses and handled tool calls
    async DraftResponse(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    ws: WebSocket,
    funcResult?: FunctionCall,
  ) {
    const requestMessages = this.PreparePrompt(request, funcResult);
    let funcCall: FunctionCall | undefined;
    let funcArguments = "";

    try {
      let events = await this.client.chat.completions.create({
        model: "gpt-4o-pk",
        messages: requestMessages,
        tools: this.PrepareFunctions(),
        stream: true,
      });

      for await (const event of events) {
        if (event.choices.length >= 1) {
          let delta = event.choices[0].delta;
          if (!delta) continue;

          if (delta.tool_calls && delta.tool_calls.length >= 1) {
            const toolCall = delta.tool_calls[0];
            if (toolCall.id) {
              if (funcCall) {
                break;
              } else {
                funcCall = {
                  id: toolCall.id,
                  funcName: toolCall.function?.name || "",
                  arguments: {},
                };
              }
            } else {
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

      // --- EXECUTE THE TOOL AND SEND BACK TO OPENAI ---
      if (funcCall) {
        // 1. Parse the text arguments accumulated from the stream into a JSON object
        if (funcArguments) {
          try {
            funcCall.arguments = JSON.parse(funcArguments);
          } catch (e) {
            console.error("Failed to parse tool arguments:", funcArguments);
            funcCall.arguments = {};
          }
        }

        console.log(`Executing tool: ${funcCall.funcName}`, funcCall.arguments);
        let toolResultText = "";

        // 2. Direct the execution depending on which function OpenAI requested
        if (funcCall.funcName === "check_availability") {
          try {
            const response = await fetch("https://api.pickd.ca/webhook-test/check-availability", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                appointment_type: funcCall.arguments.appointment_type || "cleaning",
                preferred_date: funcCall.arguments.preferred_date || "",
                clinic_id: funcCall.arguments.clinic_id || "demo_clinic"
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n Webhook communication failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Could not check availability. Try again." });
          }
        } 
        else if (funcCall.funcName === "book_appointment") {
          try {
            const response = await fetch("https://api.pickd.ca/webhook/book-appointment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                patient_name: funcCall.arguments.patient_name || "",
                dob: funcCall.arguments.dob || "",
                phone: funcCall.arguments.phone || "demo_phone",
                appointment_type: funcCall.arguments.appointment_type || "",
                slot_time: funcCall.arguments.slot_time || "",
                clinic_id: funcCall.arguments.clinic_id || "demo_clinic"
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n book-appointment Webhook failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Booking pipeline encountered an error." });
          }
        } 
        else {
          toolResultText = JSON.stringify({ status: "success", message: "Tool completed." });
        }

        // 3. Attach the tool execution payload data back into the conversation context loop
        funcCall.result = toolResultText;

        // 4. Re-run DraftResponse recursively so OpenAI evaluates the tool result and speaks
        await this.DraftResponse(request, ws, funcCall);
      }

    } catch (error) {
        console.error("Error drafting response:", error);
    }
  }

