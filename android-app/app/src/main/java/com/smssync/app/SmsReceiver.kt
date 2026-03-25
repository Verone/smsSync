package com.smssync.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.provider.Telephony
import android.util.Log
import com.google.gson.Gson
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

class SmsReceiver : BroadcastReceiver() {

    private val TAG = "SmsReceiver"
    private val client = OkHttpClient()
    private val gson = Gson()

    override fun onReceive(context: Context, intent: Intent) {
        if (Telephony.Sms.Intents.SMS_RECEIVED_ACTION == intent.action) {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            
            for (message in messages) {
                val sender = message.displayOriginatingAddress
                val messageBody = message.messageBody
                val timestamp = System.currentTimeMillis()

                Log.d(TAG, "SMS received from: $sender")
                Log.d(TAG, "Message: $messageBody")

                // Send to backend
                sendSmsToBackend(context, sender, messageBody, timestamp)
            }
        }
    }

    private fun sendSmsToBackend(
        context: Context,
        sender: String,
        message: String,
        timestamp: Long
    ) {
        val prefs: SharedPreferences = context.getSharedPreferences("SmsSyncPrefs", Context.MODE_PRIVATE)
        val backendUrl = prefs.getString("backend_url", "")

        if (backendUrl.isNullOrEmpty()) {
            Log.e(TAG, "Backend URL not configured")
            return
        }

        val apiUrl = "$backendUrl/api/sms"

        val smsData = mapOf(
            "sender" to sender,
            "message" to message,
            "timestamp" to timestamp
        )

        val json = gson.toJson(smsData)
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val requestBody = json.toRequestBody(mediaType)

        val request = Request.Builder()
            .url(apiUrl)
            .post(requestBody)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e(TAG, "Failed to send SMS to backend: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                if (response.isSuccessful) {
                    Log.d(TAG, "SMS sent to backend successfully")
                } else {
                    Log.e(TAG, "Backend returned error: ${response.code}")
                }
                response.close()
            }
        })
    }
}


