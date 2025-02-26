import json
import random

class Bank:
    CUSTOMER_FILE = "customers.json"

    def __init__(self):
        self.customers = self.load_customers()
        self.current_user = None
        self.welcome()

    def load_customers(self):
        try:
            with open(self.CUSTOMER_FILE, "r") as file:
                return json.load(file)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save_customers(self):
        with open(self.CUSTOMER_FILE, "w") as file:
            json.dump(self.customers, file, indent=4)

    def welcome(self):
        print("\n********************************")
        print("WELCOME TO VOSTE BANK")
        print("1. Log in\n2. Sign up")
        choice = input("Enter an option: ").strip()
        if choice == '1':
            self.login()
        elif choice == '2':
            self.signup()
        else:
            print("Invalid option!")
            self.welcome()

    def signup(self):
        print("\n*********** SIGN UP ***********")
        name = input("Enter your name: ").strip()
        password = input("Enter your password: ").strip()
        account_num = str(random.randint(100000, 999999))
        self.customers[account_num] = {"name": name, "password": password, "balance": 10000}
        self.save_customers()
        print("\n********************************")
        print(f"Hi {name}, your account has been created successfully.")
        print(f"Your account number is {account_num}")
        self.welcome()

    def login(self):
        print("\n********** LOG IN **********")
        account_num = input("Enter your account number: ").strip()
        password = input("Enter your password: ").strip()
        
        if account_num in self.customers and self.customers[account_num]["password"] == password:
            print(f"\nLogin successful! Welcome back, {self.customers[account_num]['name']}.")
            self.current_user = account_num
            self.transactions()
        else:
            print("\nInvalid credentials. Please try again or sign up.")
            self.welcome()

    def transactions(self):
        print("\n****** TRANSACTIONS ******")
        print("1. Deposit cash\n2. Withdraw cash\n3. Transfer cash\n4. Check balance\n5. Logout")
        choice = input("Enter an option: ").strip()

        if choice == '1':
            self.deposit()
        elif choice == '2':
            self.withdraw()
        elif choice == '3':
            self.transfer()
        elif choice == '4':
            self.check_balance()
        elif choice == '5':
            self.logout()
        else:
            print("Invalid input! Try again.")
            self.transactions()

    def deposit(self):
        amount = float(input("Enter amount to deposit: ").strip())
        if amount > 0:
            self.customers[self.current_user]["balance"] += amount
            self.save_customers()
            print(f"Deposit successful! Your new balance is {self.customers[self.current_user]['balance']}")
        else:
            print("Invalid amount!")
        self.transactions()

    def withdraw(self):
        amount = float(input("Enter amount to withdraw: ").strip())
        if 0 < amount <= self.customers[self.current_user]["balance"]:
            self.customers[self.current_user]["balance"] -= amount
            self.save_customers()
            print(f"Withdrawal successful! Your new balance is {self.customers[self.current_user]['balance']}")
        else:
            print("Insufficient balance or invalid amount!")
        self.transactions()

    def transfer(self):
        receiver_acc = input("Enter recipient account number: ").strip()
        if receiver_acc in self.customers:
            amount = float(input("Enter amount to transfer: ").strip())
            if 0 < amount <= self.customers[self.current_user]["balance"]:
                self.customers[self.current_user]["balance"] -= amount
                self.customers[receiver_acc]["balance"] += amount
                self.save_customers()
                print(f"Transfer successful! Your new balance is {self.customers[self.current_user]['balance']}")
            else:
                print("Insufficient balance or invalid amount!")
        else:
            print("Invalid recipient account number!")
        self.transactions()

    def check_balance(self):
        print(f"Your current balance is {self.customers[self.current_user]['balance']}")
        self.transactions()

    def logout(self):
        print("Logging out... Returning to home page.")
        self.current_user = None
        self.welcome()

if __name__ == "__main__":
    Bank()
