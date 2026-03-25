package com.smssync.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var backendUrlEditText: EditText
    private lateinit var statusTextView: TextView
    private lateinit var saveButton: Button

    private val PERMISSION_REQUEST_CODE = 100

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        backendUrlEditText = findViewById(R.id.backendUrlEditText)
        statusTextView = findViewById(R.id.statusTextView)
        saveButton = findViewById(R.id.saveButton)

        // Load saved backend URL
        val prefs = getSharedPreferences("SmsSyncPrefs", MODE_PRIVATE)
        val savedUrl = prefs.getString("backend_url", "")
        if (savedUrl.isNotEmpty()) {
            backendUrlEditText.setText(savedUrl)
        } else {
            backendUrlEditText.setText("http://your-backend-url.com")
        }

        saveButton.setOnClickListener {
            val url = backendUrlEditText.text.toString().trim()
            if (url.isNotEmpty()) {
                prefs.edit().putString("backend_url", url).apply()
                Toast.makeText(this, "Backend URL saved!", Toast.LENGTH_SHORT).show()
                updateStatus("Backend URL: $url")
            } else {
                Toast.makeText(this, "Please enter a valid URL", Toast.LENGTH_SHORT).show()
            }
        }

        // Request permissions
        checkAndRequestPermissions()
    }

    private fun checkAndRequestPermissions() {
        val permissions = arrayOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS
        )

        val missingPermissions = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missingPermissions.isNotEmpty()) {
            ActivityCompat.requestPermissions(
                this,
                missingPermissions.toTypedArray(),
                PERMISSION_REQUEST_CODE
            )
        } else {
            updateStatus("Permissions granted. SMS sync is active!")
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode == PERMISSION_REQUEST_CODE) {
            val allGranted = grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            if (allGranted) {
                updateStatus("Permissions granted. SMS sync is active!")
                Toast.makeText(this, "SMS sync is now active!", Toast.LENGTH_SHORT).show()
            } else {
                updateStatus("Permissions denied. Please grant SMS permissions.")
                Toast.makeText(
                    this,
                    "SMS permissions are required for the app to work",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun updateStatus(message: String) {
        statusTextView.text = message
    }
}


