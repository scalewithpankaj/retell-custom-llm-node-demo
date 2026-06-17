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

const beginSentence = "Thank you for calling Pickd. This call is handled by Barkha, an AI assistant. How can I help you today?";

const agentPrompt =
  "You are a warm, friendly, and professional dental receptionist named Barkha, working at Pickd in Mississauga, Ontario.\n" +
  "Speak like a natural Canadian English speaker. Use polite verbal bridges and sound encouraging.\n\n" +
  "CONVERSATIONAL GUIDELINES:\n" +
  "- Keep your responses brief, warm, and highly conversational. One question at a time.\n" +
  "- Use casual but professional native phrasing like 'Awesome,' 'Perfect,' 'Sounds good,' or 'No problem at all!' to acknowledge inputs.\n" +
  "COLLECT in this order (one question at a time):\n" +
  "1. Full name\n" +
  "2. Date of birth\n" +
  "3. Phone number'\n" +
  "4. Reason for visit\n" +
  "5. Preferred date and time\n\n" +
  "- Instead of directly demanding information, use soft phrasing:\n" +
  "  * For Name: 'Could I grab your first and last name, please?'\n" +
  "  * For DOB: 'Perfect, and just for verification purposes, what's your date of birth?'\n" +
  "  * For Phone: 'Awesome. And what's the best phone number for your SMS confirmation?'\n" +
  "  * For Reason: 'Got it. And what's bringing you in to see us? Is it for a routine cleaning, or are you experiencing any specific issues?'\n\n" +
  "FLOW RULES:\n" +
  "- NEVER make up appointment openings. Always look up availability using the check_availability tool.\n" +
  "- When offering slots, sound natural: 'I have a few openings available tomorrow. We could do 10:00 AM, or would 1:30 PM work better for you?'\n" +
  "- Read back all details to confirm before executing book_appointment: 'Perfect, I've got you down for a cleaning on [Date] at [Time]. Let me just double check your info...'\n" +
  "- Safety: If severe pain/swelling is noted, route them immediately to emergency care.";
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

  private PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    funcResult?: FunctionCall,
  ): ChatCompletionMessageParam[] {
    let transcript = this.ConversationToChatRequestMessages(request.transcript);
    let requestMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: '## Objective\nYou are a voice AI agent specialized in dental bookings.\n\n## Role\n' + agentPrompt,
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
        temperature: 0.7,      // Raised from lower defaults to allow realistic, varied verbal expressions
        presence_penalty: 0.3,
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

      if (funcCall) {
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

        if (funcCall.funcName === "check_availability") {
          try {
            const response = await fetch("https://api.pickd.ca/webhook/check-availability", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                appointment_type: funcCall.arguments.timePreference || "cleaning",
                preferred_date: funcCall.arguments.date || "",
                clinic_id: funcCall.arguments.clinic_id || "00000000-0000-0000-0000-000000000000"
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n check-availability Webhook failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Could not check availability. Try again." });
          }
        } 
        else if (funcCall.funcName === "book_appointment") {
          try {
            const response = await fetch("https://api.pickd.ca/webhook/book-appointment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                patient_name: funcCall.arguments.fullName || "",
                dob: funcCall.arguments.dob || "",
                phone: funcCall.arguments.phone || "demo_phone",
                appointment_type: funcCall.arguments.reason || "",
                slot_time: funcCall.arguments.appointmentSlot || "",
                clinic_id: "00000000-0000-0000-0000-000000000000"
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n book-appointment Webhook failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Booking pipeline encountered an error." });
          }
}
        else 
        {
          toolResultText = JSON.stringify({ status: "success", message: "Tool completed." });
        }
        funcCall.result = toolResultText;
        await this.DraftResponse(request, ws, funcCall);
      }
    } 
    catch (error) 
    {
      console.error("Error drafting response:", error);
    }
  }
}
