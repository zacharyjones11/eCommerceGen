output "instance_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_instance.ecommercegen.public_ip
}

output "instance_public_dns" {
  description = "Public DNS of the EC2 instance"
  value       = aws_instance.ecommercegen.public_dns
}

output "app_url" {
  description = "URL to access the running application"
  value       = "http://${aws_instance.ecommercegen.public_ip}:3000"
}

output "ssh_command" {
  description = "SSH command to connect to the instance (requires key_name to be set)"
  value       = "ssh -i <your-key.pem> ec2-user@${aws_instance.ecommercegen.public_ip}"
}
