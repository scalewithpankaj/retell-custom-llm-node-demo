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
  private client: OpenAIClient;

  constructor() {
    const baseEndpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    // Mandate the trailing /openai string so Azure AI Foundry maps correctly
    const endpoint = baseEndpoint.endsWith("/openai") ? baseEndpoint : `${baseEndpoint}/openai`;
    
    const apiKey = process.env.AZURE_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";

    this.client = new OpenAIClient(
      endpoint,
      new AzureKeyCredential(apiKey),
      { apiVersion: apiVersion }
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
    // You can copy and paste these exact bullet points as a future instruction prompt when you are ready for me to write the final production
    // code:
    // 1. External Integration Middleware & Client SetupImport Integration Libraries: Add imports for the chosen scheduling SDK (e.g., @calcom/embed-node, google-auth-library, axios for custom webhooks, or direct PMS middleware APIs).Initialize the Integration Client: Add an authenticated database or API client instance inside the FunctionCallingLlmClient class constructor alongside the OpenAIClient.Secure Environment Variables: Reference secure production variables (e.g., CLINIC_PMS_API_KEY, DENTRIX_WORKSPACE_ID, CALENDLY_WEBHOOK_SECRET) instead of mock placeholders.2. Update the check_availability Tool HandlerRemove Hardcoded Strings: Delete the static demoSlots conditional morning/afternoon strings from the function loop.Implement Live API Call: Replace the 2-second setTimeout loop with an asynchronous, awaited API fetch requesting real-time calendar availability based on the LLM's parsed arguments (funcCall.arguments.date and timePreference).Format Database Data for LLM: Add a string-parsing helper to clean up the raw JSON payload returned by your calendar (e.g., transforming a raw array of ISO timestamps into a human-friendly sentence like: "I have openings at 10:00 AM and 2:30 PM.").3. Update the book_appointment Tool HandlerRemove Mock Confirmations: Delete the hardcoded fake data-saving console payload blocks.Execute Mutation API Request: Write an asynchronous network call (POST request) to pass the complete collected patient schema (fullName, dob, phone, reason, appointmentSlot) directly to the clinic's software booking endpoint.Add Error and Collision Handling: Inject structural error handling logic. If the API returns a failure code (e.g., slot already taken, duplicate patient record, database offline), the code must intercept the error and instruct the LLM to apologize to the user and request an alternate time, instead of blindly hanging up the phone.4. Adjust the LLM Context Token LoopFeed Results back to Prompt: Modify the payload structure so that instead of sending the tool answer directly to the WebSocket (content), it returns the raw data back to the LLM's system memory using the role: "tool" structure. This allows the AI to decide how to phrase the available options naturally, rather than uttering a pre-written developer string.

      if (funcCall != null) {
        // Step 5: Call the functions
        funcCall.arguments = JSON.parse(funcArguments);

        // 1. Handle Graceful End Call
        if (funcCall.funcName === "end_call") {
          const res: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: funcCall.arguments.message,
            content_complete: true,
            end_call: true,
          };
          ws.send(JSON.stringify(res));
        }

        // 2. Handle check_availability (With morning vs. afternoon filtering + Keyboard Sound Simulation)
        if (funcCall.funcName === "check_availability") {
          const requestedDate = funcCall.arguments.date || "that day";
          const preference = (funcCall.arguments.timePreference || "").toLowerCase();
          
          let demoSlots = "";
          
          if (preference.includes("morning") || preference.includes("am")) {
            demoSlots = `For ${requestedDate}, I have morning openings at 9:00 AM and 10:30 AM.`;
          } else if (preference.includes("afternoon") || preference.includes("evening") || preference.includes("pm")) {
            demoSlots = `For ${requestedDate}, I have afternoon openings at 1:30 PM and 4:00 PM.`;
          } else {
            demoSlots = `For ${requestedDate}, we have openings at 10:00 AM, 1:30 PM, and 4:00 PM.`;
          }

          console.log(`[DEMO MODE] Simulating calendar lookup delay with audio clicks for ${requestedDate}...`);

          // STEP A: Instantly say a holding phrase and include visual/audio typing cues for the TTS engine
          const holdingRes: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: "Sure, let me check the clinic schedule for you right now... *click click*... just pulling up our calendar... *click*", 
            content_complete: false, // Keep the turn open so the patient can't interrupt the "thinking" sequence
            end_call: false,
          };
          ws.send(JSON.stringify(holdingRes));

          // STEP B: Freeze execution for exactly 2 seconds to simulate network latency
          await new Promise((resolve) => setTimeout(resolve, 2000));

          console.log(`[DEMO MODE] Delay finished. Pushing slots: ${demoSlots}`);

          // STEP C: Push final times and officially hand the microphone back to the patient
          const finalRes: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: ` Okay, I see it here. ${demoSlots} Do any of those work for you?`, 
            content_complete: true, 
            end_call: false,
          };
          ws.send(JSON.stringify(finalRes));
        }

        // 3. Handle book_appointment (With Fake Data-Saving Delay + Console Log Schema Capture)
        if (funcCall.funcName === "book_appointment") {
          const patientName = funcCall.arguments.fullName || "you";
          const chosenSlot = funcCall.arguments.appointmentSlot || "your requested time";
          
          console.log(`[DEMO MODE] Simulating database submission delay for ${patientName}...`);

          // STEP A: Send an immediate "saving" holding phrase to maintain engagement
          const savingRes: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: "Perfect, I am entering your details into our system right now... *click click*... just a brief moment while it saves your file...",
            content_complete: false,
            end_call: false,
          };
          ws.send(JSON.stringify(savingRes));

          // STEP B: Wait 2.5 seconds to simulate validation and file locking in Dentrix
          await new Promise((resolve) => setTimeout(resolve, 2500));

          // STEP C: Print the clean final data schema to the terminal for your demo audience
          console.log(`\n==================================================`);
          console.log(`🎉 DEMO CAPTURE: APPOINTMENT COMMITTED TO DATABASE`);
          console.log(`==================================================`);
          console.log(`Patient Name : ${funcCall.arguments.fullName}`);
          console.log(`Date of Birth: ${funcCall.arguments.dob}`);
          console.log(`Phone Number : ${funcCall.arguments.phone}`);
          console.log(`Reason       : ${funcCall.arguments.reason}`);
          console.log(`Locked Slot  : ${chosenSlot}`);
          console.log(`==================================================\n`);
          
          const confirmationText = ` Done! I have locked in ${chosenSlot} for you, ${patientName}. You are completely set up, and you will receive a text confirmation on your mobile phone shortly. Thank you for calling Pickd, and have a wonderful day!`;

          // STEP D: Deliver final execution confirmation text and drop the phone call link
          const finalRes: CustomLlmResponse = {
            response_type: "response",
            response_id: request.response_id,
            content: confirmationText,
            content_complete: true,
            end_call: true, // Hang up phone call seamlessly
          };
          ws.send(JSON.stringify(finalRes));
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
