package com.smssync.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.google.gson.Gson
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

class MmsReceiver : BroadcastReceiver() {

    private val TAG = "MmsReceiver"
    private val client = OkHttpClient()
    private val gson = Gson()

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val mimeType = intent.type ?: return

        if ((action == "android.provider.Telephony.WAP_PUSH_RECEIVED" ||
                    action == "android.provider.Telephony.WAP_PUSH_DELIVER") &&
            mimeType == "application/vnd.wap.mms-message"
        ) {
            Log.d(TAG, "MMS WAP push received")
            val pendingResult = goAsync()
            Thread {
                try {
                    // Small delay to ensure MMS is stored in content provider
                    Thread.sleep(2000)
                    queryAndSendLatestMms(context)
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing MMS: ${e.message}")
                } finally {
                    pendingResult.finish()
                }
            }.start()
        }
    }

    private fun queryAndSendLatestMms(context: Context) {
        val mmsUri = Uri.parse("content://mms/inbox")
        context.contentResolver.query(
            mmsUri,
            arrayOf("_id", "date", "sub"),
            null,
            null,
            "date DESC"
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val id = cursor.getLong(cursor.getColumnIndexOrThrow("_id"))
                val timestamp = cursor.getLong(cursor.getColumnIndexOrThrow("date")) * 1000
                val subject = cursor.getString(cursor.getColumnIndexOrThrow("sub")) ?: ""

                val sender = getMmsSender(context, id)
                val textBody = getMmsTextBody(context, id)
                val attachments = getMmsAttachments(context, id)

                Log.d(TAG, "MMS from: $sender, attachments: ${attachments.size}")
                sendMmsToBackend(context, sender, textBody, subject, timestamp, attachments)
            }
        }
    }

    private fun getMmsSender(context: Context, mmsId: Long): String {
        return context.contentResolver.query(
            Uri.parse("content://mms/$mmsId/addr"),
            arrayOf("address"),
            "type = 137", // PduHeaders.FROM
            null,
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) ?: "unknown" else "unknown"
        } ?: "unknown"
    }

    private fun getMmsTextBody(context: Context, mmsId: Long): String {
        val sb = StringBuilder()
        context.contentResolver.query(
            Uri.parse("content://mms/part"),
            arrayOf("_id", "ct", "_data", "text"),
            "mid = ?",
            arrayOf(mmsId.toString()),
            null
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(cursor.getColumnIndexOrThrow("ct")) == "text/plain") {
                    val data = cursor.getString(cursor.getColumnIndexOrThrow("_data"))
                    val text = if (data != null) {
                        readMmsTextPart(context, cursor.getLong(cursor.getColumnIndexOrThrow("_id")))
                    } else {
                        cursor.getString(cursor.getColumnIndexOrThrow("text")) ?: ""
                    }
                    if (sb.isNotEmpty()) sb.append("\n")
                    sb.append(text)
                }
            }
        }
        return sb.toString()
    }

    private fun readMmsTextPart(context: Context, partId: Long): String {
        return try {
            context.contentResolver.openInputStream(Uri.parse("content://mms/part/$partId"))
                ?.use { it.bufferedReader().readText() } ?: ""
        } catch (e: Exception) {
            Log.e(TAG, "Error reading MMS text part: ${e.message}")
            ""
        }
    }

    private val SUPPORTED_MEDIA = setOf(
        "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
        "video/mp4", "video/3gpp", "audio/mpeg", "audio/amr", "audio/ogg"
    )

    private fun getMmsAttachments(context: Context, mmsId: Long): List<Map<String, String>> {
        val attachments = mutableListOf<Map<String, String>>()
        context.contentResolver.query(
            Uri.parse("content://mms/part"),
            arrayOf("_id", "ct", "name"),
            "mid = ?",
            arrayOf(mmsId.toString()),
            null
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val ct = cursor.getString(cursor.getColumnIndexOrThrow("ct")) ?: continue
                if (ct !in SUPPORTED_MEDIA) continue
                val partId = cursor.getLong(cursor.getColumnIndexOrThrow("_id"))
                val name = cursor.getString(cursor.getColumnIndexOrThrow("name")) ?: "attachment"
                val data64 = readPartAsBase64(context, partId) ?: continue
                attachments.add(mapOf("contentType" to ct, "name" to name, "data" to data64))
                Log.d(TAG, "Attachment: $name ($ct, ${data64.length} b64 chars)")
            }
        }
        return attachments
    }

    private fun readPartAsBase64(context: Context, partId: Long): String? {
        return try {
            context.contentResolver.openInputStream(Uri.parse("content://mms/part/$partId"))
                ?.use { Base64.encodeToString(it.readBytes(), Base64.NO_WRAP) }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading attachment part $partId: ${e.message}")
            null
        }
    }

    private fun sendMmsToBackend(
        context: Context,
        sender: String,
        message: String,
        subject: String,
        timestamp: Long,
        attachments: List<Map<String, String>> = emptyList()
    ) {
        val prefs: SharedPreferences =
            context.getSharedPreferences("SmsSyncPrefs", Context.MODE_PRIVATE)
        val backendUrl = prefs.getString("backend_url", "")
        val apiSecret = prefs.getString("api_secret", "")

        if (backendUrl.isNullOrEmpty()) {
            Log.e(TAG, "Backend URL not configured")
            return
        }

        val mmsData = mutableMapOf<String, Any>(
            "sender" to sender,
            "message" to message,
            "timestamp" to timestamp,
            "type" to "MMS"
        )
        if (subject.isNotEmpty()) mmsData["subject"] = subject
        if (attachments.isNotEmpty()) mmsData["attachments"] = attachments

        val json = gson.toJson(mmsData)
        val requestBody = json.toRequestBody("application/json; charset=utf-8".toMediaType())

        val requestBuilder = Request.Builder()
            .url("$backendUrl/api/sms")
            .post(requestBody)

        if (!apiSecret.isNullOrEmpty()) {
            requestBuilder.addHeader("Authorization", "Bearer $apiSecret")
        }

        client.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e(TAG, "Failed to send MMS to backend: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                if (response.isSuccessful) {
                    Log.d(TAG, "MMS sent to backend successfully")
                } else {
                    Log.e(TAG, "Backend returned error: ${response.code}")
                }
                response.close()
            }
        })
    }
}
