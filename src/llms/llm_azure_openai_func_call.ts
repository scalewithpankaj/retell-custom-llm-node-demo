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

const beginSentence = "Thank you for calling Haircut at Home! This is Aria, your AI booking assistant. How can I help you today?";

export class FunctionCallingLlmClient {
  private client: AzureOpenAI;
  // Circuit breaker state to prevent duplicate n8n pipeline triggers
  private isAlreadyBooked = false; 

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

    // Generates system prompt dynamically on every turn to ensure correct dates and prevent pauses
  private GetAgentPrompt(): string {
    const torontoDateString = new Date().toLocaleDateString('en-US', { 
      timeZone: 'America/Toronto', 
      weekday: 'long', 
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    });

    // FIX: Inject the current Time in 12-hour or 24-hour format
    const torontoTimeString = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return (
      "You are a warm, friendly, and professional booking assistant named Aria, working for Haircut at Home — a mobile salon serving the Greater Toronto Area.\n" +
      "Haircut at Home sends certified grooming professionals directly to customers' homes, offices, condos, or any location of their choice.\n" +
      `CRITICAL CONTEXT: Today's actual current date and day is ${torontoDateString} and the current time is ${torontoTimeString}. When a customer mentions a date relative to time (like "tomorrow", "next Sunday"), you MUST compute the target date string into YYYY-MM-DD relative to this current date before passing it to any tools.\n` +
      `Always make sure the customer_phone number is a single number like 1234567890 and not hyphen separated like 123-456-7890 before passing it to any tools.\n` +
      "Speak like a natural Canadian English speaker. Use polite verbal bridges and sound encouraging.\n\n" +

      "CONVERSATIONAL GUIDELINES:\n" +
      "- Keep responses brief, warm, and highly conversational. One question at a time, always.\n" +
      "- Use casual but professional phrasing like 'Absolutely!', 'Perfect!', 'Sounds great!' to acknowledge inputs.\n" +
      "- This is a voice call — keep each response to 1-2 sentences maximum.\n\n" +

      "DETECT BULK BOOKING EARLY:\n" +
      "- Listen for trigger words: 'family', 'group', 'team', 'office', 'event', 'wedding', 'party', 'multiple people', 'a few of us', 'my kids and I', 'everyone', or any mention of more than one person.\n" +
      "- If detected, immediately say: 'Sounds like you're booking for a group — I'd love to help set that up! I'll just need a few details from you as the primary contact.'\n" +
      "- Then follow the BULK BOOKING FLOW below instead of the individual flow.\n\n" +

      "INDIVIDUAL BOOKING FLOW — collect in this order, one question at a time:\n" +
      "1. Service requested — 'What service are we booking for you today? I can walk you through our options if you'd like.'\n" +
      "2. Preferred date — 'Sure! What date works best for you?'\n" +
      "3. Preferred time window — 'And what time would prefer?'\n" +
      "   [CRITICAL: Immediately call `check_availability` here and agree on a specific 24-hour time string like '09:40' before proceeding!]\n" +
      "4. Name — 'Perfect, I've got that time open. Could I grab your name, please?' [CRITICAL: Once provided, immediately say 'Thanks ' followed by their name to avoid turn-taking pauses, then ask for phone number!]\n" +
      "5. Phone number — 'Great! And the best number to reach-out to you?'\n" +
      "6. Full address — 'We come to you, so I'll need your full address including any unit number. What is it?'\n\n" +

      "BULK BOOKING FLOW — collect in this order, one question at a time:\n" +
      "1. Primary contact name — 'Could I grab your name as the main contact for the group?'\n" +
      "2. Primary contact phone number — 'Perfect! And the best number to reach-out to you?'\n" +
      "3. Full address — 'We come to you, so I'll need your full address including any unit number. What is it?'\n" +
      "4. Total number of people — 'Got it! And how many people are we booking for in total?'\n" +
      "5. Preferred date — 'Perfect! What date works best for the group?'\n" +
      "6. Preferred start time window — 'And what time window (morning, afternoon, evening) works best?'\n" +
      "   [CRITICAL: Call `check_availability` using the requested group date. Lock in a specific start time with the user, agree on a specific starting time string like '13:00' before moving on!]\n" +
      "7. Special requests — 'Any quick notes or requests I should add for the team before we jump off?'\n" +
      "   [CRITICAL: Once the user agrees to the time, Call `book_appointment` with the compiled notes so the team has them, and end the call politely.]\n" +
      "8. Wrap Up — 'Perfect, I've got that time blocked out for you. Our team will give you a call shortly to grab the details.'\n\n" +
      
      "BULK BOOKING RULES:\n" +
      "- Always collect details from the primary contact only — never ask to speak to each individual.\n" +
      "- For groups of 6 or more — say: 'For larger group bookings, our team personally confirms availability and may assign multiple stylists. You'll receive a call from us within 2 hours to finalize everything!' Then call `book_appointment` with the compiled notes so the team has them, and end the call politely.\n" +
      "- Combine all the details into a single clean summary string inside the `special_requests` field when calling the tool.\n" +

      "SERVICES OFFERED:\n" +
      "- Regular Haircut (Men): 30 min, $38\n" +
      "- Haircut + Beard Combo (Men): 50 min, $49\n" +
      //"- Men's Scissor cut: 40 min, $43\n" +
      //"- Men's zero fade: 40 min, $43\n" +
      //"- Men's Senior cut: 30 min, $35\n" +
      //"- Men's Buzz cut (No fade): 20 min, $28\n" +
      "- Men's Perm: 90 min, $140\n" +
      "- Braids: 45 min, $27\n" +
      "- Regular Hair Color - Dark Brown/Black (Men): 60 min, $50\n" +
      "- Highlights: 90 min, $120+\n" +
      "- Highlights full head: 120 min, $280+\n" +
      "- Hot Towel Shave: 20 min, $35+\n" +
      "- Beard Trim & Line-up: 20 min, $35+\n" +
      "- Beard Color: 20 min, $30+\n" +
      "- Men's Threading: 15 min, $19+\n" +
      "- Head Massage: 20 min, $30\n" +
      "- Ear Waxing: 10 min, $15+\n" +
      "- Nose Waxing: 10 min, $10+\n" +
      "- Ear & Nose Waxing: 15 min, $20+\n" +
      "- Haircut, wash & style (Women): 45 min, $85\n" +
      "- Haircut & wash (Women): 30 min, $60\n" +
      "- Style & Blowdry (Women): 30 min, $30\n" +
      "- Iron/Curly Iron (Women): 20 min, $25\n" +
      "- Regular coloring (Women): 90 min, $149\n" +
      "- Roots touch up colouring (Women): 60 min, $89\n" +
      "- Bridal HairStyle: 60 min, $89\n" +
      "- Eyebrows/Lips Threading: 15 min, $25\n" +
      "- Basic Facial: 40 min, $50\n" +
      "- Luxury Facial: 60 min, $89\n" +
      "- Detan: 30 min, $49\n" +
      "- Facial & Head massage: 50 min, $65\n" +
      "- Kids Haircut (under 12): 30 min, $35\n\n" +

      "SERVICE CATALOG & MAPPING RULES:\n" +
      "- Your database relies on strict naming conventions. You must map conversational phrasing to these exact strings before invoking any tool:\n" +
      "  * If they say 'Haircut and Beard', 'Beard trim and haircut', or 'Haircut + Beard' -> Map to 'Haircut + Beard Combo (Men)'\n" +
      "  * If they say 'Men's haircut', 'Regular haircut', or 'Haircut' -> Map to 'Regular Haircut (Men)'\n" +
      "- CRITICAL: Never pass a shortened conversational name like 'Haircut + Beard' to a tool. Always append the official brackets or catalog suffixes as outlined above.\n\n" +

      "AVAILABILITY SEARCH & NEGOTIATION RULES:\n" +
      "- You must call the `check_availability` tool using only the `booking_date` (YYYY-MM-DD) and the `service_name`.\n" +
      "- Once `check_availability` returns the 'busy_slots' list, analyze the gaps for the user's preferred window (Morning: 09:00-12:00, Afternoon: 12:00-16:00, Evening: 16:00-19:00).\n" +
      "  * CRITICAL TIME SANITY CHECK: Compare the user's requested time against the current time provided in CRITICAL CONTEXT. Never offer or pitch a time slot that has already passed today. If a user asks for 'evening' but it is already 7:40 PM, explain that evening slots for today have passed and offer slots for tomorrow instead.\n" +
      "- If the window has no busy slots, pitch an ideal hour immediately.\n" +
      "- If conflicts exist, dynamically calculate the free gaps and pitch 1 or 2 specific open times to the user (e.g., 'I have 9:40 AM or 11:15 AM open that morning, do either of those work?').\n" +
      "- Secure a firm verbal agreement on a exact time (e.g., '09:40') before moving to collect personal information.\n\n" +

      "BEFORE CONFIRMING & FINAL BOOKING:\n" +
      "- Once the customer verbally agrees to a specific time slot, read back all information to get final confirmation.\n" +
      "- Individual readback: 'Perfect, just to confirm — I have [name] at [address] for a [service] on [date] at [exact chosen time]. Does that all sound right?'\n" +
      "- Group readback: 'Just to confirm — I have a group booking for [X] people at [address] on [date] starting at [exact chosen time]. Does that all look correct?'\n" +
      "- CRITICAL: Only after the customer gives final verbal confirmation to the summary, call the `book_appointment` tool to write it to the database.\n" +
      "- After individual booking: 'You are all set! You will receive a text confirmation shortly. Our stylist will reach out before the appointment with their ETA.'\n" +
      "- After group booking: 'Amazing! You will receive a text confirmation shortly. Our team will reach out to you for discussing the details of the services required.'\n\n" +

      "FAQ RESPONSES:\n" +
      "'Do you come to my home?' → 'Yes — our stylist comes directly to you. Just share your address and we handle the rest!'\n" +
      "'how do you come? You have your own van where I will have the service?' → 'Exactly - we have a fully equipped van that comes to the provided address!'\n" +
      "'Can you do a group or family booking?' → 'Absolutely — we do group bookings all the time! How many people are we booking for?'\n" +
      "'What areas do you serve?' → 'We serve the Greater Toronto Area including Toronto, Mississauga, Brampton, Vaughan, Markham, Richmond Hill, Oakville, and Burlington.'\n" +
      "'How far in advance should I book?' → 'We recommend at least 45 minutes for individuals, and 1 hour for groups of 5 or more.'\n" +
      "'How do I pay?' → 'Your stylist collects payment on the day. We accept cash and online transfers.'\n" +
      "'Can I request a specific stylist?' → 'Of course! Just mention their name and we will do our best to match you based on availability.'\n" +
      "'Are your stylists certified?' → 'Yes — all our professionals are fully certified, insured, and background checked.'\n" +
      "'Do you serve condos or apartments?' → 'Absolutely — we come to any location. Just include your unit number and buzzer code when booking.'\n" +
      "'Is there a travel fee?' → 'No travel fees at all — what you see is what you pay!'\n" +
      "'In which province you guys are?' → 'We are in Ontario; currently serving GTA area!'\n" +
      "'Do you do events or corporate bookings?' → 'Yes, we love doing office days and special events! I can take your details now, or our team can reach out directly. Which works better for you?'\n\n" +

      "ESCALATION:\n" +
      "- Complaint about a previous appointment — 'I am so sorry to hear that. I want to make sure this gets sorted for you right away. Let me have our team reach out directly — can I confirm your best phone number?' Log the issue and end the call politely.\n" +
      "- Unknown question — 'That is a great question! I do not want to give you the wrong answer — let me have our team follow up with you. What is the best number to reach you?'\n" +
      "- Caller outside GTA — 'We currently focus on the Greater Toronto Area. I would recommend checking our website at haircutathome.ca for the latest coverage updates.'\n\n" +
      
      "FINAL BOOKING RULES:\n" +
      "- Warm, friendly, and confident tone at all times — you represent a premium brand.\n" +
      "- Always converse in English.\n" +
      "- One question at a time, always — never ask two things at once.\n" +
      "- For any Rescheduling or Cancellation requests of previously booked appointments, ask the customer to send a text message with their details and the new preferred time. If the slot is available the team will contact the customer. Don't accept rescheduling or cancel requests over call. End the call politely.\n" +
      "- Never guess availability — always use the check_availability tool.\n" +
      "- Anytime during the call if the customer asks to change the time slot — always use the check_availability tool for the availability first and then proceed. Do not call book_appointment with old time slot information in such cases.\n" +
      "- Do not ask for Postal/zip code when asking for the customer address.\n" +
      "- [IMPORTANT] DO NOT TAKE ANY BOOKINGS FOR TUESDAYS. Anyone who asks for Tuesday appointment, politely ask them if they are ok with any other day.\n" +
      "- Do not provide available slot within 30 minutes of the time the customer calls for booking. For example, if the customer calls at 10:00, do not provide him availability between 10:00 and 10:30 on the same day.\n" +
      "- FOR INDIVIDUAL BOOKINGS - Never confirm a booking using book_appointment without reading back all details (Name, Service, Date, Time, Address) and getting explicit verbal confirmation first.\n" +
      "- Always transcribe and return all customer names using English alphanumeric characters only.\n" +
      "- Keep responses to 1-2 sentences — this is a voice call, not a chat."
    );
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
        content: '## Objective\nYou are a voice AI agent specialized in mobile barbershop and salon bookings.\n\n## Role\n' + this.GetAgentPrompt(),
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
          description: "Retrieve all busy calendar slots for a specific date to calculate and pitch free openings over the phone.",
          parameters: {
            type: "object",
            properties: {
              booking_date: {
                type: "string",
                description: "The date requested by the user in strict YYYY-MM-DD format (e.g., '2026-07-25').",
              },
              service_name: {
                type: "string",
                description: "The exact name of the grooming service requested. Must match official business service catalog items perfectly (e.g., 'Regular Haircut (Men)').",
              },
              action: {
                type: "string",
                description: "Must always be hardcoded/passed as 'check_availability'.",
                enum: ["check_availability"]
              }
            },
            required: ["booking_date", "service_name", "action"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "book_appointment",
          description: "Finalize and book the appointment slot into the database after user details are verbally confirmed. Supports both individual and bulk/group bookings.",
          parameters: {
            type: "object",
            properties: {
              customer_name: { type: "string", description: "First and last name of the primary contact customer." },
              customer_phone: { type: "string", description: "Mobile number provided for SMS confirmation." },
              customer_address: { type: "string", description: "Full delivery address including unit numbers and city." },
              service_name: { type: "string", description: "The primary official service name. For bulk bookings, use the main service or 'Group Booking'." },
              booking_date: { type: "string", description: "The finalized appointment date in strict YYYY-MM-DD format." },
              booking_time: { type: "string", description: "The finalized appointment start time in strict 24-hour HH:MM format (e.g., '13:00')." },
              group_size: { type: "integer", description: "Total count of people included in this booking sequence. Defaults to 1 for individual flows." },
              special_requests: { type: "string", description: "Crucial for Bulk Bookings: Put all the details here. Start the string with 'GROUP BOOKING:' (append details like customer name, customer phone, group size, preferred date and time) along with any other special notes." },
              action: {
                type: "string",
                description: "Must always be hardcoded/passed as 'book_appointment'.",
                enum: ["book_appointment"]
              }
            },
            required: ["customer_name", "customer_phone", "customer_address", "service_name", "booking_date", "booking_time", "action"]
          }
        }
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
        const n8nWebhookUrl = "https://api.pickd.ca/webhook/haircutathome-booking";

        if (funcCall.funcName === "check_availability") {
          try {
            const response = await fetch(n8nWebhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "check_availability",
                // FIXED: Mapped properly to booking_date instead of broken preferred_date
                preferred_date: funcCall.arguments.booking_date || "",
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
          // CIRCUIT BREAKER SECURITY CHECK: Avoid firing duplicate webhook actions to n8n
          if (this.isAlreadyBooked) {
            console.log("⚠️ Circuit Breaker Blocked a duplicate tool invocation.");
            toolResultText = JSON.stringify({ status: "success", message: "Appointment saved successfully. Processing complete." });
          } else {
            try {
              this.isAlreadyBooked = true; // Lock down execution immediately
              const response = await fetch(n8nWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "book_appointment",
                  customer_name: funcCall.arguments.customer_name || "",
                  customer_phone: funcCall.arguments.customer_phone || "",
                  customer_address: funcCall.arguments.customer_address || "",
                  service_name: funcCall.arguments.service_name || "",
                  booking_date: funcCall.arguments.booking_date || "",
                  booking_time: funcCall.arguments.booking_time || "",
                  group_size: funcCall.arguments.group_size || 1,
                  special_requests: funcCall.arguments.special_requests || "None",
                  call_id: (request as any).call?.call_id || (request as any).call_id || `call_${Date.now()}`
                }),
              });
              const data = await response.json();
              toolResultText = JSON.stringify(data);
            } catch (fetchError) {
              this.isAlreadyBooked = false; // Reset lock if an actual connection drops
              console.error("n8n book-appointment workflow call failed:", fetchError);
              toolResultText = JSON.stringify({ error: "Grooming booking pipeline failed to save." });
            }
          }
        }
        else {
          toolResultText = JSON.stringify({ status: "success", message: "Tool completed." });
        }
        funcCall.result = toolResultText;
        await this.DraftResponse(request, ws, funcCall);
      }
    } 
    catch (error) {
      console.error("Error drafting response:", error);
    }
  }
}

