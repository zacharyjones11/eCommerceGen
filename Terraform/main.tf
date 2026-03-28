terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.3.0"
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Security Group
# ---------------------------------------------------------------------------
resource "aws_security_group" "ecommercegen_sg" {
  name        = "ecommercegen-sg"
  description = "Allow HTTP on app port, HTTPS, and SSH inbound; all outbound"

  # SSH — restrict to your IP in production; 0.0.0.0/0 left open for class demo
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
  }

  # Application port (Node app listens on 3000)
  ingress {
    description = "App HTTP"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Standard HTTPS (handy if you add a reverse proxy later)
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow all outbound so the instance can pull from Docker Hub, run updates, etc.
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "ecommercegen-sg"
    Project = "eCommerceGen"
  }
}

# ---------------------------------------------------------------------------
# EC2 Instance
# ---------------------------------------------------------------------------
resource "aws_instance" "ecommercegen" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [aws_security_group.ecommercegen_sg.id]

  # Bootstrap: install Docker, pull the image, run the container
  user_data = <<-EOF
    #!/bin/bash
    set -e

    # Update and install Docker
    yum update -y
    yum install -y docker
    systemctl enable docker
    systemctl start docker

    # Allow ec2-user to run docker without sudo
    usermod -aG docker ec2-user

    # Pull and run the eCommerceGen container
    docker pull ${var.docker_image}
    docker run -d \
      --name ecommercegen \
      --restart unless-stopped \
      -p 3000:3000 \
      ${var.docker_image}
  EOF

  tags = {
    Name    = "ecommercegen-server"
    Project = "eCommerceGen"
  }
}
