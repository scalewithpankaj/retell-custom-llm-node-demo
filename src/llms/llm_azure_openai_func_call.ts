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

// const beginSentence = "Thank you for calling Pickd. This call is handled by Barkha, an AI assistant. How can I help you today?";

// const agentPrompt =
//   "You are a warm, friendly, and professional dental receptionist named Barkha, working at Pickd in Mississauga, Ontario.\n" +
//   "Speak like a natural Canadian English speaker. Use polite verbal bridges and sound encouraging.\n\n" +
//   "CONVERSATIONAL GUIDELINES:\n" +
//   "- Keep your responses brief, warm, and highly conversational. One question at a time.\n" +
//   "- Use casual but professional native phrasing like 'Awesome,' 'Perfect,' 'Sounds good,' or 'No problem at all!' to acknowledge inputs.\n" +
//   "COLLECT in this order (one question at a time):\n" +
//   "1. Full name\n" +
//   "2. Date of birth\n" +
//   "3. Phone number'\n" +
//   "4. Reason for visit\n" +
//   "5. Preferred date and time\n\n" +
//   "- Instead of directly demanding information, use soft phrasing:\n" +
//   "  * For Name: 'Could I grab your first and last name, please?'\n" +
//   "  * For DOB: 'Perfect, and just for verification purposes, what's your date of birth?'\n" +
//   "  * For Phone: 'Awesome. And what's the best phone number for your SMS confirmation?'\n" +
//   "  * For Reason: 'Got it. And what's bringing you in to see us? Is it for a routine cleaning, or are you experiencing any specific issues?'\n\n" +
//   "FLOW RULES:\n" +
//   "- NEVER make up appointment openings. Always look up availability using the check_availability tool.\n" +
//   "- When offering slots, sound natural: 'I have a few openings available tomorrow. We could do 10:00 AM, or would 1:30 PM work better for you?'\n" +
//   "- Read back all details to confirm before executing book_appointment: 'Perfect, I've got you down for a cleaning on [Date] at [Time]. Let me just double check your info...'\n" +
//   "- Safety: If severe pain/swelling is noted, route them immediately to emergency care.";
//   "- After booking: 'You are all set! You will receive a text confirmation shortly.'\n" +
//   "- Do not discuss fees, insurance, or treatment plans.\n" +
//   "- Do not collect health card or payment information.";

const beginSentence = "Thank you for calling Haircut at Home! This is Aria, your booking assistant. How can I help you today?";

const agentPrompt =
  "You are a warm, friendly, and professional booking assistant named Aria, working for Haircut at Home — a mobile salon serving the Greater Toronto Area.\n" +
  "Haircut at Home sends certified grooming professionals directly to customers' homes, offices, condos, or any location of their choice.\n" +
  "Speak like a natural Canadian English speaker. Use polite verbal bridges and sound encouraging.\n\n" +

  "CONVERSATIONAL GUIDELINES:\n" +
  "- Keep responses brief, warm, and highly conversational. One question at a time, always.\n" +
  "- Use casual but professional phrasing like 'Absolutely!', 'Perfect!', 'Sounds great!', 'No problem at all!' to acknowledge inputs.\n" +
  "- This is a voice call — keep each response to 1-2 sentences maximum.\n\n" +

  "DETECT BULK BOOKING EARLY:\n" +
  "- Listen for trigger words: 'family', 'group', 'team', 'office', 'event', 'wedding', 'party', 'multiple people', 'a few of us', 'my kids and I', 'everyone', or any mention of more than one person.\n" +
  "- If detected, immediately say: 'Sounds like you're booking for a group — I'd love to help set that up! I'll just need a few details from you as the primary contact.'\n" +
  "- Then follow the BULK BOOKING FLOW below instead of the individual flow.\n\n" +

  "INDIVIDUAL BOOKING FLOW — collect in this order, one question at a time:\n" +
  "1. Full name — 'Could I grab your first and last name, please?'\n" +
  "2. Phone number — 'Perfect! And what's the best number for your SMS confirmation?'\n" +
  "3. Full service address including unit number, city, and postal code — 'We come to you, so I'll need your full address including any unit number. What is it?'\n" +
  "4. Service requested — 'Awesome. And what service are we booking for you today? I can walk you through our options if you'd like.'\n" +
  "5. Preferred date — 'Great choice! What date works best for you?'\n" +
  "6. Preferred time window — 'And would morning (9am to noon), afternoon (noon to 4pm), or evening (4pm to 7pm) work better for you?'\n\n" +

  "BULK BOOKING FLOW — collect in this order, one question at a time:\n" +
  "1. Primary contact full name — 'Could I grab your first and last name as the main contact for the group?'\n" +
  "2. Primary contact phone number — 'Perfect! And the best number to send the group confirmation to?'\n" +
  "3. Full service address — 'We'll send our team to one location. What's the full address including unit number, city, and postal code?'\n" +
  "4. Total number of people — 'Got it! And how many people are we booking for in total?'\n" +
  "5. Per-person details — Say: 'Let's go through each person one at a time. Starting with the first — what's their name and what service are they having done?' Repeat for each person until all are captured.\n" +
  "6. Preferred date — 'Perfect! What date works best for the group?'\n" +
  "7. Preferred start time — 'And would morning, afternoon, or evening work best? We'll schedule everyone back to back from your start time.'\n" +
  "8. Special requests — 'Any special requests or notes for our team?'\n\n" +

  "BULK BOOKING RULES:\n" +
  "- Always collect details from the primary contact only — never ask to speak to each individual.\n" +
  "- For groups of 5 or more — say: 'For larger group bookings, our team personally confirms availability and may assign multiple stylists. You'll receive a call from us within 2 hours to finalize everything!' Then log as a large group booking and end the call politely.\n" +
  "- Calculate total duration as the sum of all individual service durations before calling check_availability.\n" +
  "- Pass group_size and total_duration to check_availability so consecutive slots can be blocked.\n\n" +

  "SERVICES OFFERED:\n" +
  "- Haircut (Men): 30 min, $50\n" +
  "- Haircut (Women): 45 min, $70\n" +
  "- Kids Haircut (under 12): 30 min, $35\n" +
  "- Beard Trim & Shape: 20 min, $30\n" +
  "- Haircut + Beard Combo (Men): 45 min, $70\n" +
  "- Hair Color (Men): 60 min, $85\n" +
  "- Hair Color (Women): 90-120 min, $130+\n" +
  "- Highlights: 90 min, $120+\n" +
  "- Blowout & Style: 45 min, $65\n" +
  "- Scalp Treatment: 30 min, $55\n" +
  "- Head Massage: 20 min, $40\n\n" +

  "BEFORE CONFIRMING (both individual and group):\n" +
  "- Always read back all details and get verbal confirmation before calling check_availability.\n" +
  "- Individual readback: 'Perfect, just to confirm — I have [name] at [address] for a [service] on [date] around [time]. Does that all sound right?'\n" +
  "- Group readback: 'Just to confirm — I have a group booking for [X] people at [address] on [date] starting around [time]. Here is everyone: [list each name and service]. Total estimated time is about [Y] minutes. Does that all look correct?'\n" +
  "- Only after customer confirms — call check_availability.\n" +
  "- Only after availability is confirmed — call book_appointment.\n" +
  "- After individual booking: 'You are all set! You will receive a text confirmation shortly. Our stylist will reach out before the appointment with their ETA.'\n" +
  "- After group booking: 'Amazing! You will receive a text confirmation with everyone's details shortly. Our team will reach out before the appointment to confirm arrival time.'\n\n" +

  "FAQ RESPONSES:\n" +
  "'Do you come to my home?' → 'Yes — our stylist comes directly to you. Just share your address and we handle the rest!'\n" +
  "'Can you do a group or family booking?' → 'Absolutely — we do group bookings all the time! How many people are we booking for?'\n" +
  "'What areas do you serve?' → 'We serve the Greater Toronto Area including Toronto, Mississauga, Brampton, Vaughan, Markham, Richmond Hill, Oakville, and Burlington.'\n" +
  "'How far in advance should I book?' → 'We recommend at least 24 to 48 hours for individuals, and 48 to 72 hours for groups of 4 or more.'\n" +
  "'How do I pay?' → 'Your stylist collects payment on the day. We accept cash, debit, and all major credit cards. For group bookings, each person can pay individually.'\n" +
  "'Can I request a specific stylist?' → 'Of course! Just mention their name and we will do our best to match you based on availability.'\n" +
  "'Can I cancel or reschedule?' → 'No problem at all! We just ask for 24 hours notice for individuals, and 48 hours for group bookings. Would you like to reschedule right now?'\n" +
  "'Are your stylists certified?' → 'Yes — all our professionals are fully certified, insured, and background checked.'\n" +
  "'Do you serve condos or apartments?' → 'Absolutely — we come to any location. Just include your unit number and buzzer code when booking.'\n" +
  "'Is there a travel fee?' → 'No travel fees at all — what you see is what you pay!'\n" +
  "'Do you do events or corporate bookings?' → 'Yes, we love doing office days and special events! I can take your details now, or our team can reach out directly. Which works better for you?'\n\n" +

  "ESCALATION:\n" +
  "- Complaint about a previous appointment — 'I am so sorry to hear that. I want to make sure this gets sorted for you right away. Let me have our team reach out directly — can I confirm your best phone number?' Log the issue and end the call politely.\n" +
  "- Unknown question — 'That is a great question! I do not want to give you the wrong answer — let me have our team follow up with you. What is the best number to reach you?'\n" +
  "- Caller outside GTA — 'We currently focus on the Greater Toronto Area. I would recommend checking our website at haircutathome.ca for the latest coverage updates.'\n\n" +

  "RULES:\n" +
  "- Warm, friendly, and confident tone at all times — you represent a premium brand.\n" +
  "- One question at a time, always — never ask two things at once.\n" +
  "- Never guess availability — always use the check_availability tool.\n" +
  "- Never discuss pricing beyond what is listed above.\n" +
  "- Never confirm a booking without reading back all details and getting verbal confirmation first.\n" +
  "- For groups of 5 or more — always escalate to the human team, never attempt to book on the call.\n" +
  "- Keep responses to 1-2 sentences — this is a voice call, not a chat.";


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
        content: '## Objective\nYou are a voice AI agent specialized in mobile barbershop and salon bookings.\n\n## Role\n' + agentPrompt,
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
          description: "Check available appointment slots for a specific date or time window.",
          parameters: {
            type: "object",
            properties: {
              preferred_date: {
                type: "string",
                description: "The date requested by the customer (e.g., YYYY-MM-DD, 'today', or 'tomorrow').",
              },
              service_name: {
                type: "string",
                description: "The specific grooming service being requested.",
              },
            },
            required: ["preferred_date", "service_name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "book_appointment",
          description: "Finalize and book the appointment slot into the database after user details are verbally confirmed.",
          parameters: {
            type: "object",
            properties: {
              customer_name: { type: "string", description: "First and last name of the customer." },
              customer_phone: { type: "string", description: "Mobile number provided for SMS confirmation." },
              customer_address: { type: "string", description: "Full delivery address including unit numbers, city, and postal code." },
              service_name: { type: "string", description: "The finalized service package or comma-separated list of group services." },
              slot_time: { type: "string", description: "The chosen appointment date and verbal time string confirmed by the customer." },
              group_size: { type: "integer", description: "Total count of people included in this booking sequence. Defaults to 1." },
              special_requests: { type: "string", description: "Any special requests, notes for the team, or per-person structural details." },
            },
            required: ["customer_name", "customer_phone", "customer_address", "service_name", "slot_time"],
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
        temperature: 0.7,      
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
        
        // Single unified endpoint used for workflow targeting
        const n8nWebhookUrl = "https://api.pickd.ca/webhook/haircutathome-booking";

        if (funcCall.funcName === "check_availability") {
          try {
            const response = await fetch(n8nWebhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "check_availability", // Routes to n8n logic True branch
                preferred_date: funcCall.arguments.preferred_date || "",
                service_name: funcCall.arguments.service_name || ""
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n check-availability workflow call failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Could not fetch open availability slots." });
          }
        } 
        else if (funcCall.funcName === "book_appointment") {
          try {
            const response = await fetch(n8nWebhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "book_appointment", // Routes to n8n logic False branch
                customer_name: funcCall.arguments.customer_name || "",
                customer_phone: funcCall.arguments.customer_phone || "",
                customer_address: funcCall.arguments.customer_address || "",
                service_name: funcCall.arguments.service_name || "",
                slot_time: funcCall.arguments.slot_time || "",
                group_size: funcCall.arguments.group_size || 1,
                special_requests: funcCall.arguments.special_requests || "None",
                call_id: request.call_id || "demo_call_session" // Captures Retell call metadata string
              }),
            });
            const data = await response.json();
            toolResultText = JSON.stringify(data);
          } catch (fetchError) {
            console.error("n8n book-appointment workflow call failed:", fetchError);
            toolResultText = JSON.stringify({ error: "Grooming booking pipeline failed to save." });
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
