package http_test

import (
	"errors"
	"testing"

	"github.com/SebastienMelki/sebuf/http"
)

func TestValidationError_Error(t *testing.T) {
	tests := []struct {
		name     string
		err      *http.ValidationError
		expected string
	}{
		{
			name:     "nil error",
			err:      nil,
			expected: "validation error: <nil>",
		},
		{
			name:     "empty violations",
			err:      &http.ValidationError{Violations: []*http.FieldViolation{}},
			expected: "validation error: no violations",
		},
		{
			name: "single violation",
			err: &http.ValidationError{
				Violations: []*http.FieldViolation{
					{Field: "email", Description: "must be a valid email address"},
				},
			},
			expected: "validation error: email: must be a valid email address",
		},
		{
			name: "multiple violations",
			err: &http.ValidationError{
				Violations: []*http.FieldViolation{
					{Field: "email", Description: "must be a valid email address"},
					{Field: "name", Description: "required field missing"},
				},
			},
			expected: "validation error: [email: must be a valid email address, name: required field missing]",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := tt.err.Error()
			if actual != tt.expected {
				t.Errorf("ValidationError.Error() = %q, want %q", actual, tt.expected)
			}
		})
	}
}

func TestError_Error(t *testing.T) {
	tests := []struct {
		name     string
		err      *http.Error
		expected string
	}{
		{
			name:     "nil error",
			err:      nil,
			expected: "error: <nil>",
		},
		{
			name:     "empty message",
			err:      &http.Error{Message: ""},
			expected: "error: empty message",
		},
		{
			name:     "with message",
			err:      &http.Error{Message: "user not found"},
			expected: "user not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := tt.err.Error()
			if actual != tt.expected {
				t.Errorf("Error.Error() = %q, want %q", actual, tt.expected)
			}
		})
	}
}

func TestErrorInterface_Implementation(t *testing.T) {
	// Test that ValidationError implements error interface
	var validationErr error = &http.ValidationError{
		Violations: []*http.FieldViolation{
			{Field: "email", Description: "invalid format"},
		},
	}

	// Test that Error implements error interface
	var sebufErr error = &http.Error{Message: "something went wrong"}

	// Test errors.As functionality
	t.Run("errors.As with ValidationError", func(t *testing.T) {
		var target *http.ValidationError
		if !errors.As(validationErr, &target) {
			t.Error("errors.As should work with ValidationError")
		}
		if target == nil {
			t.Error("target should not be nil")
		}
		if len(target.GetViolations()) != 1 || target.GetViolations()[0].GetField() != "email" {
			t.Error("target should contain the original violation")
		}
	})

	t.Run("errors.As with Error", func(t *testing.T) {
		var target *http.Error
		if !errors.As(sebufErr, &target) {
			t.Error("errors.As should work with Error")
		}
		if target == nil {
			t.Error("target should not be nil")
		}
		if target.GetMessage() != "something went wrong" {
			t.Error("target should contain the original message")
		}
	})

	// Test errors.Is functionality
	t.Run("errors.Is with same instance", func(t *testing.T) {
		if !errors.Is(validationErr, validationErr) {
			t.Error("errors.Is should work with same ValidationError instance")
		}
		if !errors.Is(sebufErr, sebufErr) {
			t.Error("errors.Is should work with same Error instance")
		}
	})
}

func TestErrorInterface_Wrapping(t *testing.T) {
	// Test that our errors work when wrapped
	originalValidationErr := &http.ValidationError{
		Violations: []*http.FieldViolation{
			{Field: "name", Description: "required"},
		},
	}

	wrappedErr := errors.New("wrapped: " + originalValidationErr.Error())

	// Should be able to extract from error message
	expectedMsg := "validation error: name: required"
	if originalValidationErr.Error() != expectedMsg {
		t.Errorf("ValidationError.Error() = %q, want %q", originalValidationErr.Error(), expectedMsg)
	}

	// Test Error type as well
	originalErr := &http.Error{Message: "database connection failed"}
	wrappedSebufErr := errors.New("service failed: " + originalErr.Error())

	if originalErr.Error() != "database connection failed" {
		t.Errorf("Error.Error() = %q, want %q", originalErr.Error(), "database connection failed")
	}

	// Verify wrapped errors contain our error messages
	expectedWrapped := "wrapped: validation error: name: required"
	if wrappedErr.Error() != expectedWrapped {
		t.Errorf("wrappedErr.Error() = %q, want %q", wrappedErr.Error(), expectedWrapped)
	}

	expectedWrappedSebuf := "service failed: database connection failed"
	if wrappedSebufErr.Error() != expectedWrappedSebuf {
		t.Errorf("wrappedSebufErr.Error() = %q, want %q", wrappedSebufErr.Error(), expectedWrappedSebuf)
	}
}
