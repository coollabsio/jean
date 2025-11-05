package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/coollabsio/jean/session"
)

// TestSearchBasedModalInput_NavigateUp tests up arrow navigation in search modal
func TestSearchBasedModalInput_NavigateUp(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.branches = []string{"main", "develop", "feature/test"}
	m.filteredBranches = m.branches
	m.branchIndex = 2
	m.modalFocused = 1 // In list

	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	// Press up arrow
	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyUp},
		config,
	)

	if resultModel.(Model).branchIndex != 1 {
		t.Errorf("Expected branchIndex 1, got %d", resultModel.(Model).branchIndex)
	}
}

// TestSearchBasedModalInput_NavigateDown tests down arrow navigation in search modal
func TestSearchBasedModalInput_NavigateDown(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.branches = []string{"main", "develop", "feature/test"}
	m.filteredBranches = m.branches
	m.branchIndex = 0
	m.modalFocused = 1 // In list

	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	// Press down arrow
	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyDown},
		config,
	)

	if resultModel.(Model).branchIndex != 1 {
		t.Errorf("Expected branchIndex 1, got %d", resultModel.(Model).branchIndex)
	}
}

// TestSearchBasedModalInput_FocusTransition tests focus movement from search to list
func TestSearchBasedModalInput_FocusTransition(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.branches = []string{"main", "develop"}
	m.filteredBranches = m.branches
	m.modalFocused = 0 // In search input

	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	// Press down from search input (should move to list)
	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyDown},
		config,
	)

	result := resultModel.(Model)
	if result.modalFocused != 1 {
		t.Errorf("Expected modalFocused 1 (list), got %d", result.modalFocused)
	}
}

// TestSearchBasedModalInput_TypeToSearch tests typing in list updates search
func TestSearchBasedModalInput_TypeToSearch(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.branches = []string{"main", "develop", "feature/test", "hotfix/bug"}
	m.filteredBranches = m.branches
	m.modalFocused = 1 // In list
	m.searchInput = textinput.New()

	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	// Type "feat" while in list
	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'f'}},
		config,
	)

	result := resultModel.(Model)
	if result.searchInput.Value() != "f" {
		t.Errorf("Expected search input to have 'f', got '%s'", result.searchInput.Value())
	}
	if result.modalFocused != 0 {
		t.Errorf("Expected modalFocused 0 (search), got %d", result.modalFocused)
	}
}

// TestSearchBasedModalInput_EnterConfirm tests Enter key confirms selection
func TestSearchBasedModalInput_EnterConfirm(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.branches = []string{"main", "develop"}
	m.filteredBranches = m.branches
	m.branchIndex = 0
	m.modalFocused = 2 // On action button

	confirmCalled := false
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			confirmCalled = true
			if branch != "main" {
				t.Errorf("Expected branch 'main', got '%s'", branch)
			}
			return m, nil
		},
	}

	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyEnter},
		config,
	)

	if !confirmCalled {
		t.Error("Expected onConfirm to be called")
	}

	result := resultModel.(Model)
	if result.modal != noModal {
		t.Errorf("Expected modal to close, modal state: %d", result.modal)
	}
}

// TestSearchBasedModalInput_CancelButton tests Cancel button closes without action
func TestSearchBasedModalInput_CancelButton(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal
	m.modalFocused = 3 // On cancel button

	confirmCalled := false
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			confirmCalled = true
			return m, nil
		},
	}

	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyEnter},
		config,
	)

	if confirmCalled {
		t.Error("Expected onConfirm NOT to be called when pressing Cancel")
	}

	result := resultModel.(Model)
	if result.modal != noModal {
		t.Errorf("Expected modal to close, modal state: %d", result.modal)
	}
}

// TestSearchBasedModalInput_Escape tests Esc closes modal
func TestSearchBasedModalInput_Escape(t *testing.T) {
	m := setupTestModel()
	m.modal = branchSelectModal

	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleSearchBasedModalInput(
		tea.KeyMsg{Type: tea.KeyEsc},
		config,
	)

	result := resultModel.(Model)
	if result.modal != noModal {
		t.Errorf("Expected modal to close on Esc, modal state: %d", result.modal)
	}
}

// TestListSelectionModalInput_NavigateUp tests up arrow navigation in list
func TestListSelectionModalInput_NavigateUp(t *testing.T) {
	m := setupTestModel()
	m.sessions = []session.Session{
		{Name: "session1"},
		{Name: "session2"},
	}
	m.sessionIndex = 1

	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyUp},
		config,
	)

	if resultModel.(Model).sessionIndex != 0 {
		t.Errorf("Expected sessionIndex 0, got %d", resultModel.(Model).sessionIndex)
	}
}

// TestListSelectionModalInput_NavigateDown tests down arrow navigation in list
func TestListSelectionModalInput_NavigateDown(t *testing.T) {
	m := setupTestModel()
	m.sessions = []session.Session{
		{Name: "session1"},
		{Name: "session2"},
	}
	m.sessionIndex = 0

	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyDown},
		config,
	)

	if resultModel.(Model).sessionIndex != 1 {
		t.Errorf("Expected sessionIndex 1, got %d", resultModel.(Model).sessionIndex)
	}
}

// TestListSelectionModalInput_CustomKey tests custom key handler (e.g., 'd' for delete)
func TestListSelectionModalInput_CustomKey(t *testing.T) {
	m := setupTestModel()
	m.sessions = []session.Session{
		{Name: "session1"},
		{Name: "session2"},
	}
	m.sessionIndex = 0

	customKeyUsed := false
	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
		onCustomKey: func(m Model, key string) (tea.Model, tea.Cmd) {
			if key == "d" {
				customKeyUsed = true
			}
			return m, nil
		},
	}

	m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}},
		config,
	)

	if !customKeyUsed {
		t.Error("Expected custom key handler to be called")
	}
}

// TestListSelectionModalInput_Escape tests Esc closes modal
func TestListSelectionModalInput_Escape(t *testing.T) {
	m := setupTestModel()
	m.modal = sessionListModal

	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyEsc},
		config,
	)

	result := resultModel.(Model)
	if result.modal != noModal {
		t.Errorf("Expected modal to close on Esc, modal state: %d", result.modal)
	}
}

// TestListSelectionModalInput_BoundaryCheck_Up tests up doesn't go below 0
func TestListSelectionModalInput_BoundaryCheck_Up(t *testing.T) {
	m := setupTestModel()
	m.sessions = []session.Session{
		{Name: "session1"},
		{Name: "session2"},
	}
	m.sessionIndex = 0 // Already at top

	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyUp},
		config,
	)

	if resultModel.(Model).sessionIndex != 0 {
		t.Errorf("Expected sessionIndex to stay 0, got %d", resultModel.(Model).sessionIndex)
	}
}

// TestListSelectionModalInput_BoundaryCheck_Down tests down doesn't exceed max
func TestListSelectionModalInput_BoundaryCheck_Down(t *testing.T) {
	m := setupTestModel()
	m.sessions = []session.Session{
		{Name: "session1"},
		{Name: "session2"},
	}
	m.sessionIndex = 1 // At bottom

	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			return m, nil
		},
	}

	resultModel, _ := m.handleListSelectionModalInput(
		tea.KeyMsg{Type: tea.KeyDown},
		config,
	)

	if resultModel.(Model).sessionIndex != 1 {
		t.Errorf("Expected sessionIndex to stay 1, got %d", resultModel.(Model).sessionIndex)
	}
}

// Helper function to set up a basic test model
func setupTestModel() Model {
	return Model{
		width:  80,
		height: 24,
		modal:  noModal,
	}
}
