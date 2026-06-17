import {
  OpenAIClient,
  AzureKeyCredential,
  ChatRequestMessage,
  GetChatCompletionsOptions,
  ChatCompletionsFunctionToolDefinition,
} from "@azure/openai";
import { AzureOpenAI } from "openai";
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
  "Thank you for calling Pickd. This call is handled by Barkha, an AI assistant. How can I help you today?";

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

// export class FunctionCallingLlmClient {
//   private client: OpenAIClient;

//   constructor() {
//     this.client = new OpenAIClient(
//       process.env.AZURE_OPENAI_ENDPOINT,
//       new AzureKeyCredential(process.env.AZURE_OPENAI_KEY),
//     );
//   }

  export class FunctionCallingLlmClient {
  private client: AzureOpenAI;

  constructor() {
    // Modern openai reads AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY from process.env natively.
    // We explicitly map them here to preserve your fallbacks exactly as before:
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

      // Function to check dental availability
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

      // Function to book the appointment
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
  // Revert this method back to use the original streamChatCompletions function
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
        // Step 5: Safely parse the function arguments passed by the AI
        funcCall.arguments = JSON.parse(funcArguments);

        // If the AI explicitly decides it is time to end the call
        if (funcCall.funcName === "end_call") {
          const res: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: funcCall.arguments.message,
            content_complete: true,
            end_call: true,
          };
          ws.send(JSON.stringify(res));
        } else {
  // 1. Identify which n8n webhook endpoint to target based on the tool requested
  let targetUrl = "";
  let payload = {};

  if (funcCall.funcName === "check_availability") {
    targetUrl = process.env.N8N_CHECK_AVAILABILITY_URL || "";
    payload = {
      body: {
        preferred_date: funcCall.arguments.date,
        time_preference: funcCall.arguments.timePreference
      }
    };
  } else if (funcCall.funcName === "book_appointment") {
    targetUrl = process.env.N8N_BOOK_APPOINTMENT_URL || "";
    payload = {
      body: {
        patient_name: funcCall.arguments.fullName,
        dob: funcCall.arguments.dob,
        phone: funcCall.arguments.phone,
        appointment_type: funcCall.arguments.reason,
        slot_time: funcCall.arguments.appointmentSlot
      }
    };
  }

    // 2. Programmatically execute the backend request to your live n8n workflows
  let spokenResponse = "I'm sorry, I am having trouble accessing the scheduling calendar right now.";
  
  if (targetUrl) {
    try {
      console.log(`Forwarding payload to n8n workflow (${funcCall.funcName}):`, payload);
      
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      const n8nData: any = await response.json();
      
      // Extract the slots or message returned directly by your n8n JavaScript Code node
      if (funcCall.funcName === "check_availability" && n8nData?.slots) {
        const slotsList = n8nData.slots.join(", or ");
        spokenResponse = `I see openings on ${slotsList}. Which of those works for you?`;
      } else if (funcCall.funcName === "book_appointment" && n8nData?.message) {
        spokenResponse = n8nData.message;
      }
    } catch (n8nError) {
      console.error("Failed to fetch data from n8n webhook instance:", n8nError);
    }
  }

  // 3. Send the formatted text dynamically back to the active voice stream
  const res: CustomLlmResponse = {
    response_type: "response",
    response_id: request.response_id,
    content: spokenResponse,
    content_complete: true,
    end_call: false,
  };
  ws.send(JSON.stringify(res));
}


      } else {
        // Standard conversational turns (no tool execution requested)
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
