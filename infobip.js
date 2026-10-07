require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health check
app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Infobip webhook is running"
    });
});

// Upserts a list of Infobip message results into Supabase
async function processResults(results) {
        for (const result of results) {

            // Rejected messages carry the reason in `status`, not `error`
            if (!result.error && result.status && result.status.groupName === "REJECTED") {
                result.error = {
                    id: result.status.id,
                    name: result.status.description || result.status.name
                };
            }

            const messageId = result.messageId;

            if (!messageId) {
                console.log("No messageId. Skipping.");
                continue;
            }

            const recipient = result.to || null;
            const callbackData = result.callbackData || null;


            // =====================================================
            // READ / SEEN CALLBACK
            // =====================================================

            if (result.seenAt) {

                console.log(`Message ID: ${messageId}`);
                console.log(`Message READ at: ${result.seenAt}`);

                const { data: existingMessage, error: findError } =
                    await supabase
                        .from("bsi_whatsapp_status")
                        .select("message_id")
                        .eq("message_id", messageId)
                        .maybeSingle();

                if (findError) {
                    console.error("Find message error:", findError);
                    continue;
                }

                // If message does not exist, create it
                if (!existingMessage) {

                    const { data, error } = await supabase
                        .from("bsi_whatsapp_status")
                        .insert({
                            message_id: messageId,
                            recipient: recipient,
                            status: "READ",
                            read_at: result.seenAt,
                            sent_at: result.sentAt || null,
                            infobip_payload: result
                        })
                        .select("*");

                    if (error) {
                        console.error("READ INSERT failed:", error);
                    } else {
                        console.log(
                            "Created new message:",
                            JSON.stringify(data, null, 2)
                        );
                    }

                } else {

                    // Existing message → UPDATE
                    const { data, error } = await supabase
                        .from("bsi_whatsapp_status")
                        .update({
                            status: "READ",
                            read_at: result.seenAt,
                            recipient: recipient,
                            infobip_payload: result,
                            updated_at: new Date().toISOString()
                        })
                        .eq("message_id", messageId)
                        .select("*");

                    if (error) {
                        console.error("READ UPDATE failed:", error);
                    } else {
                        console.log(
                            "Updated message to READ:",
                            JSON.stringify(data, null, 2)
                        );
                    }
                }

                continue;
            }


            // =====================================================
            // DELIVERY STATUS CALLBACK
            // =====================================================

            if (result.status) {

                const status = result.status.name;

                console.log(`Message ID: ${messageId}`);
                console.log(`Status: ${status}`);


                // Check whether message already exists
                const { data: existingMessage, error: findError } =
                    await supabase
                        .from("bsi_whatsapp_status")
                        .select("message_id")
                        .eq("message_id", messageId)
                        .maybeSingle();


                if (findError) {
                    console.error("Find message error:", findError);
                    continue;
                }


                // =================================================
                // FIRST CALLBACK → INSERT
                // =================================================

                if (!existingMessage) {

                    const insertData = {
                        message_id: messageId,
                        recipient: recipient,
                        status: status,
                        sent_at: result.sentAt || null,
                        delivered_at:
                            status === "DELIVERED"
                                ? result.doneAt || null
                                : null,

                        infobip_payload: result
                    };


                    // Error information
                    if (result.error) {

                        insertData.error_code =
                            result.error.id || null;

                        insertData.error_name =
                            result.error.name || null;
                    }


                    const { data, error } = await supabase
                        .from("bsi_whatsapp_status")
                        .insert(insertData)
                        .select("*");


                    if (error) {

                        console.error(
                            "Supabase INSERT failed:",
                            error
                        );

                    } else {

                        console.log(
                            "Created new message:",
                            JSON.stringify(data, null, 2)
                        );
                    }

                }


                // =================================================
                // SUBSEQUENT CALLBACK → UPDATE
                // =================================================

                else {

                    const updateData = {
                        status: status,
                        recipient: recipient,
                        infobip_payload: result,
                        updated_at: new Date().toISOString()
                    };


                    if (result.sentAt) {
                        updateData.sent_at = result.sentAt;
                    }


                    if (status === "DELIVERED") {

                        updateData.delivered_at =
                            result.doneAt ||
                            new Date().toISOString();
                    }


                    // Error information
                    if (result.error) {

                        updateData.error_code =
                            result.error.id || null;

                        updateData.error_name =
                            result.error.name || null;
                    }


                    const { data, error } = await supabase
                        .from("bsi_whatsapp_status")
                        .update(updateData)
                        .eq("message_id", messageId)
                        .select("*");


                    if (error) {

                        console.error(
                            "Supabase UPDATE failed:",
                            error
                        );

                    } else {

                        console.log(
                            "Updated message:",
                            JSON.stringify(data, null, 2)
                        );
                    }
                }

                continue;
            }


            console.log(
               `No status or seenAt found for ${messageId}`
            );
        }
}

// Infobip webhook
app.post("/webhook/infobip", async (req, res) => {

    console.log("=================================");
    console.log("Infobip webhook received");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=================================");

    try {

        // Accept delivery reports ({ results: [...] }), send responses
        // ({ messages: [...] }) and a single bare message object
        // (e.g. the REJECTED response returned when sending).
        const results =
            req.body.results ||
            req.body.messages ||
            (req.body.messageId ? [req.body] : []);

        await processResults(results);


        // Tell Infobip we successfully processed the callback
        return res.status(200).json({
            success: true
        });


    } catch (error) {

        console.error("Webhook error:", error);

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});